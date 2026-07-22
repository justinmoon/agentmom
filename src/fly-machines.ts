import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { AppConfig } from "./config.js";
import type { PreviewFetchRequest, PreviewFetchResponse } from "./previews.js";

const MACHINES_API = "https://api.machines.dev/v1";
const GRAPHQL_API = "https://api.fly.io/graphql";

export type FlyExec = (
  command: string,
  cwd: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }
) => Promise<{ exitCode: number | null }>;

/**
 * One Fly Machine per workspace: app `am-ws-<id16>`, a volume at /workspace,
 * and the sandbox shim on :8080 behind the app's fly.dev hostname.
 */
export class FlySandbox {
  private machineId?: string;
  private provisioned = false;
  /** Best-effort belief that the machine is running (avoids polling the API). */
  up = false;
  private startedPromise?: Promise<void>;
  private lastActivity = Date.now();

  constructor(private readonly config: AppConfig) {}

  get appName(): string {
    const id = (this.config.workspaceId ?? "default").replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    return `${this.config.fly.appPrefix}${id.slice(0, 16) || "default"}`;
  }

  get guestWorkspace(): string {
    return "/workspace";
  }

  private get shimToken(): string {
    return createHmac("sha256", this.config.fly.token).update(this.config.workspaceId ?? "default").digest("hex");
  }

  private get shimBase(): string {
    return `https://${this.appName}.fly.dev`;
  }

  markActivity(): void {
    this.lastActivity = Date.now();
  }

  idleMs(): number {
    return Date.now() - this.lastActivity;
  }

  // ---- Machines/GraphQL API ------------------------------------------------

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${MACHINES_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`fly ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : undefined;
  }

  private async allocateSharedIp(): Promise<void> {
    const response = await fetch(GRAPHQL_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }",
        variables: { input: { appId: this.appName, type: "shared_v4" } }
      })
    });
    const payload = (await response.json()) as { errors?: Array<{ message: string }> };
    const message = payload.errors?.[0]?.message ?? "";
    if (message && !/already|taken/i.test(message)) {
      throw new Error(`fly ip allocation failed for ${this.appName}: ${message}`);
    }
  }

  async ensureProvisioned(): Promise<void> {
    if (this.provisioned && this.machineId) return;

    await this.api("POST", "/apps", { app_name: this.appName, org_slug: this.config.fly.org }).catch((error) => {
      if (!/taken|exists/i.test(String(error))) throw error;
    });
    await this.allocateSharedIp();

    const volumes = (await this.api("GET", `/apps/${this.appName}/volumes`)) as Array<{ id: string; name: string }>;
    let volume = volumes.find((entry) => entry.name === "workspace");
    volume ??= await this.api("POST", `/apps/${this.appName}/volumes`, {
      name: "workspace",
      size_gb: this.config.fly.volumeGb,
      region: this.config.fly.region
    });

    const machines = (await this.api("GET", `/apps/${this.appName}/machines`)) as Array<{ id: string; state: string }>;
    if (machines.length > 0) {
      this.machineId = machines[0].id;
      this.provisioned = true;
      return;
    }

    const bootstrap = `curl -fsSL ${this.config.fly.shimUrl} -o /tmp/agentmom-shim.mjs && exec node /tmp/agentmom-shim.mjs`;
    const machine = await this.api("POST", `/apps/${this.appName}/machines`, {
      name: "sandbox",
      region: this.config.fly.region,
      config: {
        image: this.config.fly.image,
        guest: { cpu_kind: "shared", cpus: this.config.fly.cpus, memory_mb: this.config.fly.memoryMb },
        env: {
          AGENTMOM_SHIM_TOKEN: this.shimToken,
          AGENTMOM_WORKSPACE: this.guestWorkspace,
          HOME: this.guestWorkspace
        },
        init: { exec: ["/bin/bash", "-c", bootstrap] },
        mounts: [{ volume: (volume as { id: string }).id, path: this.guestWorkspace }],
        services: [
          {
            protocol: "tcp",
            internal_port: 8080,
            autostart: true,
            autostop: "off",
            ports: [
              { port: 80, handlers: ["http"] },
              { port: 443, handlers: ["tls", "http"] }
            ]
          }
        ],
        restart: { policy: "always" },
        auto_destroy: false
      }
    });
    this.machineId = machine.id as string;
    this.provisioned = true;
  }

  /** Start (or confirm) the machine and wait until the shim answers. */
  async ensureStarted(): Promise<void> {
    this.startedPromise ??= this.startInner().finally(() => {
      this.startedPromise = undefined;
    });
    return this.startedPromise;
  }

  private async startInner(): Promise<void> {
    await this.ensureProvisioned();
    if (await this.shimHealthy(1500)) {
      this.up = true;
      return;
    }

    await this.api("POST", `/apps/${this.appName}/machines/${this.machineId}/start`, {}).catch((error) => {
      // Freshly created machines boot on their own ("created"/"starting"),
      // and racing wakes hit "already started" — all fine, we poll the shim.
      if (!/already started|not stopped|current state/i.test(String(error))) throw error;
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await this.shimHealthy(2000)) {
        this.up = true;
        this.markActivity();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`sandbox for ${this.appName} did not become ready`);
  }

  private async shimHealthy(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.shimBase}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    if (!this.machineId) return;
    this.up = false;
    await this.api("POST", `/apps/${this.appName}/machines/${this.machineId}/stop`, {}).catch(() => {});
  }

  async machineState(): Promise<string | undefined> {
    if (!this.machineId) return undefined;
    const machine = await this.api("GET", `/apps/${this.appName}/machines/${this.machineId}`).catch(() => undefined);
    return machine?.state as string | undefined;
  }

  // ---- Shim calls ----------------------------------------------------------

  private async shimFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${this.shimBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.shimToken}`, ...(init.headers ?? {}) },
        signal: init.signal ?? controller.signal
      });
      if (response.status === 401) throw new Error("shim auth failed");
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  createBashExec(): FlyExec {
    return async (command, _cwd, options) => {
      this.markActivity();
      await this.ensureStarted();

      const response = await this.shimFetch("/exec", {
        method: "POST",
        body: JSON.stringify({ command, cwd: this.guestWorkspace, timeout: options.timeout }),
        timeoutMs: (options.timeout ?? 600_000) + 30_000,
        signal: options.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`sandbox exec failed: HTTP ${response.status}`);
      }

      let exitCode: number | null = null;
      let pending = "";
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += Buffer.from(value).toString("utf8");
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline === -1) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const record = JSON.parse(line) as { o?: string; e?: string; x?: number | null; t?: boolean; err?: string };
          if (record.o) options.onData(Buffer.from(record.o, "base64"));
          if (record.e) options.onData(Buffer.from(record.e, "base64"));
          if (record.t) options.onData(Buffer.from("\n[command timed out]\n", "utf8"));
          if (record.err) options.onData(Buffer.from(`${record.err}\n`, "utf8"));
          if (record.x !== undefined) exitCode = record.x;
        }
      }
      this.markActivity();
      return { exitCode };
    };
  }

  async spawnDetached(command: string, cwd: string): Promise<void> {
    this.markActivity();
    await this.ensureStarted();
    const response = await this.shimFetch("/spawn", {
      method: "POST",
      body: JSON.stringify({ command, cwd })
    });
    if (!response.ok) throw new Error(`sandbox spawn failed: HTTP ${response.status}`);
  }

  async readFile(guestPath: string): Promise<Buffer> {
    await this.ensureStarted();
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(guestPath)}`);
    if (response.status === 404 || response.status === 500) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error((payload as { error?: string }).error ?? `read failed`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async writeFile(guestPath: string, content: string | Buffer): Promise<void> {
    this.markActivity();
    await this.ensureStarted();
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(guestPath)}`, {
      method: "PUT",
      body: content as BodyInit
    });
    if (!response.ok) throw new Error(`write failed: HTTP ${response.status}`);
  }

  async mkdir(guestPath: string): Promise<void> {
    await this.ensureStarted();
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(guestPath)}&op=mkdir`, { method: "POST" });
    if (!response.ok) throw new Error(`mkdir failed: HTTP ${response.status}`);
  }

  async access(guestPath: string): Promise<void> {
    await this.ensureStarted();
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(guestPath)}&op=access`);
    if (!response.ok) {
      throw new Error(`ENOENT: no access to ${guestPath}`);
    }
  }

  async proxy(port: number, request: PreviewFetchRequest): Promise<PreviewFetchResponse> {
    this.markActivity();
    await this.ensureStarted();
    const response = await this.shimFetch("/proxy", {
      method: "POST",
      body: JSON.stringify({
        port,
        method: request.method,
        path: request.path,
        headers: request.headers,
        bodyBase64: request.body ? Buffer.from(request.body).toString("base64") : undefined
      }),
      timeoutMs: 60_000
    });
    const payload = (await response.json()) as {
      status?: number;
      headers?: Record<string, string>;
      bodyBase64?: string;
      error?: string;
    };
    if (!response.ok || payload.error) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: Buffer.from(payload.error ?? "proxy failed") };
    }
    return {
      status: payload.status ?? 502,
      headers: payload.headers ?? {},
      body: Buffer.from(payload.bodyBase64 ?? "", "base64")
    };
  }

  /** Push a local directory into the machine (tar over HTTP). */
  async pushDir(localDir: string, guestPath: string): Promise<void> {
    await this.ensureStarted();
    const tar = spawn("tar", ["-C", localDir, "--exclude=node_modules", "-czf", "-", "."]);
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (data: Buffer) => chunks.push(data));
    await new Promise<void>((resolvePromise, reject) => {
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar failed (${code})`))));
    });
    const response = await this.shimFetch(`/untar?path=${encodeURIComponent(guestPath)}`, {
      method: "POST",
      body: Buffer.concat(chunks) as BodyInit,
      timeoutMs: 300_000
    });
    if (!response.ok) throw new Error(`push failed: HTTP ${response.status}`);
  }

  /** Pull a directory from the machine into a local dir (optionally incremental). */
  async pullDir(guestPath: string, localDir: string, sinceMs?: number): Promise<void> {
    await this.ensureStarted();
    mkdirSync(localDir, { recursive: true });
    const since = sinceMs ? `&since=${Math.floor(sinceMs)}` : "";
    const response = await this.shimFetch(`/tar?path=${encodeURIComponent(guestPath)}${since}`, {
      timeoutMs: 300_000
    });
    if (!response.ok || !response.body) throw new Error(`pull failed: HTTP ${response.status}`);

    const untar = spawn("tar", ["-C", localDir, "-xzf", "-"]);
    const reader = response.body.getReader();
    const failure = new Promise<never>((_, reject) => untar.on("error", reject));
    const finished = new Promise<void>((resolvePromise, reject) => {
      untar.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`untar failed (${code})`))));
    });
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failure]);
      if (done) break;
      if (!untar.stdin.write(Buffer.from(value))) {
        await new Promise((r) => untar.stdin.once("drain", r));
      }
    }
    untar.stdin.end();
    await finished;
  }

  /** Map a host projectsDir path to the guest path, mirroring smolvm behavior. */
  hostToGuest(hostPath: string): string | undefined {
    const projects = this.config.projectsDir.replace(/\/+$/, "");
    if (hostPath === projects) return this.guestWorkspace;
    if (hostPath.startsWith(`${projects}/`)) {
      return `${this.guestWorkspace}/${hostPath.slice(projects.length + 1)}`;
    }
    return undefined;
  }

  guestToHost(guestPath: string): string | undefined {
    if (guestPath === this.guestWorkspace) return this.config.projectsDir;
    if (guestPath.startsWith(`${this.guestWorkspace}/`)) {
      return `${this.config.projectsDir}/${guestPath.slice(this.guestWorkspace.length + 1)}`;
    }
    return undefined;
  }
}
