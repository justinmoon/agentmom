import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";

const MACHINES_API = "https://api.machines.dev/v1";
const GRAPHQL_API = "https://api.fly.io/graphql";
const SITE_ROOT = "/workspace/site";
const SWEEP_MS = 60_000;

export type TutorialFile = { path: string; size: number };
export type TutorialExecResult = { output: string; exitCode: number | null };

type QuotaState = {
  day: string;
  total: number;
  users: Record<string, number>;
};

function numberSetting(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function demoId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

function safeRelativePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw Object.assign(new Error("Invalid demo file path."), { status: 400 });
  }
  return path;
}

export class TutorialVibeManager {
  private readonly sandboxes = new Map<string, TutorialFlySandbox>();
  private readonly running = new Set<string>();
  private readonly quotaPath: string;
  private readonly timer?: NodeJS.Timeout;
  private readonly startupSweep: Promise<void>;

  constructor(private readonly config: AppConfig) {
    this.quotaPath = join(config.stateDir, "technically-speaking-vibe-quota.json");
    if (process.env.AGENTMOM_TUTORIAL_SANDBOX_URL || !config.fly.token || !config.fly.shimUrl) {
      this.startupSweep = Promise.resolve();
      return;
    }
    this.startupSweep = this.deleteOrphanedApps().catch((error) => {
      console.warn(`demo sandbox startup sweep failed: ${String(error)}`);
    });
    this.timer = setInterval(() => void this.sweep().catch(() => {}), SWEEP_MS);
    this.timer.unref();
  }

  configured(): boolean {
    return Boolean(process.env.AGENTMOM_TUTORIAL_SANDBOX_URL || (this.config.fly.token && this.config.fly.shimUrl));
  }

  async begin(userId: string): Promise<{ sandbox: TutorialFlySandbox; release: () => void }> {
    await this.startupSweep;
    if (!this.configured()) throw Object.assign(new Error("The Fly demo sandbox is not configured."), { status: 503 });
    if (this.running.has(userId)) {
      throw Object.assign(new Error("This user already has a website build running."), { status: 409 });
    }
    const maxActive = numberSetting("TECHNICALLY_SPEAKING_VIBE_MAX_ACTIVE_SANDBOXES", 5);
    if (maxActive > 0 && !this.sandboxes.has(userId) && this.sandboxes.size >= maxActive) {
      throw Object.assign(new Error("All website demo sandboxes are busy. Try again shortly."), { status: 429 });
    }
    this.claimQuota(userId);
    this.running.add(userId);
    const sandbox = this.get(userId);
    sandbox.touch();
    return { sandbox, release: () => this.running.delete(userId) };
  }

  get(userId: string): TutorialFlySandbox {
    let sandbox = this.sandboxes.get(userId);
    if (!sandbox) {
      sandbox = new TutorialFlySandbox(this.config, userId);
      this.sandboxes.set(userId, sandbox);
    }
    sandbox.touch();
    return sandbox;
  }

  async reset(userId: string): Promise<void> {
    if (this.running.has(userId)) throw Object.assign(new Error("Wait for the current build to finish."), { status: 409 });
    const sandbox = this.sandboxes.get(userId) ?? new TutorialFlySandbox(this.config, userId);
    this.sandboxes.delete(userId);
    await sandbox.destroy();
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    const sandboxes = [...this.sandboxes.values()];
    this.sandboxes.clear();
    await Promise.allSettled(sandboxes.map((sandbox) => sandbox.destroy()));
  }

  async sweepNow(): Promise<void> {
    await this.sweep();
  }

  existing(userId: string): TutorialFlySandbox {
    const sandbox = this.sandboxes.get(userId);
    if (!sandbox) throw Object.assign(new Error("Run the website demo first."), { status: 404 });
    sandbox.touch();
    return sandbox;
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [userId, sandbox] of this.sandboxes) {
      if (this.running.has(userId) || !sandbox.expired(now)) continue;
      this.sandboxes.delete(userId);
      await sandbox.destroy().catch(() => {});
    }
    await this.deleteEmptyApps();
  }

  private async flyApi(method: string, path: string): Promise<any> {
    const response = await fetch(`${MACHINES_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Fly ${method} ${path} returned ${response.status}.`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private async demoApps(): Promise<Array<{ name: string }>> {
    const result = (await this.flyApi("GET", `/apps?org_slug=${encodeURIComponent(this.config.fly.org)}`)) as {
      apps?: Array<{ name: string }>;
    };
    return (result.apps ?? []).filter((app) => app.name.startsWith(this.config.fly.demoAppPrefix));
  }

  private async deleteOrphanedApps(): Promise<void> {
    for (const app of await this.demoApps()) {
      await this.flyApi("DELETE", `/apps/${app.name}`).catch(() => {});
    }
  }

  private async deleteEmptyApps(): Promise<void> {
    const activeNames = new Set([...this.sandboxes.values()].map((sandbox) => sandbox.appName));
    for (const app of await this.demoApps()) {
      if (activeNames.has(app.name)) continue;
      const machines = (await this.flyApi("GET", `/apps/${app.name}/machines`).catch(() => [])) as unknown[];
      if (machines.length === 0) await this.flyApi("DELETE", `/apps/${app.name}`).catch(() => {});
    }
  }

  private claimQuota(userId: string): void {
    const day = new Date().toISOString().slice(0, 10);
    const perUser = numberSetting("TECHNICALLY_SPEAKING_VIBE_RUNS_PER_USER_PER_DAY", 10);
    const global = numberSetting("TECHNICALLY_SPEAKING_VIBE_RUNS_PER_DAY", 100);
    let state: QuotaState = { day, total: 0, users: {} };
    try {
      if (existsSync(this.quotaPath)) state = JSON.parse(readFileSync(this.quotaPath, "utf8")) as QuotaState;
    } catch {
      state = { day, total: 0, users: {} };
    }
    if (state.day !== day) state = { day, total: 0, users: {} };
    if (global > 0 && state.total >= global) {
      throw Object.assign(new Error("The daily website demo limit has been reached."), { status: 429 });
    }
    if (perUser > 0 && (state.users[userId] ?? 0) >= perUser) {
      throw Object.assign(new Error("You have reached today’s website demo limit."), { status: 429 });
    }
    state.total += 1;
    state.users[userId] = (state.users[userId] ?? 0) + 1;
    mkdirSync(dirname(this.quotaPath), { recursive: true });
    const temp = `${this.quotaPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, this.quotaPath);
  }
}

export class TutorialFlySandbox {
  readonly appName: string;
  private machineId?: string;
  private started?: Promise<void>;
  private firstActivity = Date.now();
  private lastActivity = Date.now();

  constructor(private readonly config: AppConfig, private readonly userId: string) {
    this.appName = `${config.fly.demoAppPrefix}${demoId(userId)}`;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  expired(now = Date.now()): boolean {
    return (
      now - this.lastActivity >= this.config.fly.demoIdleMinutes * 60_000 ||
      now - this.firstActivity >= this.config.fly.demoMaxMinutes * 60_000
    );
  }

  async ensureStarted(): Promise<void> {
    this.touch();
    this.started ??= this.start().finally(() => {
      this.started = undefined;
    });
    await this.started;
  }

  async exec(command: string, timeoutMs = 15_000): Promise<TutorialExecResult> {
    await this.ensureStarted();
    await this.mkdir();
    const response = await this.shimFetch("/exec", {
      method: "POST",
      body: JSON.stringify({ command, cwd: SITE_ROOT, timeout: timeoutMs }),
      timeoutMs: timeoutMs + 10_000
    });
    if (!response.ok || !response.body) throw new Error(`Sandbox command failed: HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let output = "";
    let exitCode: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line) as { o?: string; e?: string; x?: number | null; t?: boolean; err?: string };
        if (item.o) output += Buffer.from(item.o, "base64").toString("utf8");
        if (item.e) output += Buffer.from(item.e, "base64").toString("utf8");
        if (item.t) output += "\n[command timed out]\n";
        if (item.err) output += `${item.err}\n`;
        if (item.x !== undefined) exitCode = item.x;
      }
    }
    this.touch();
    return { output: output.slice(0, 64 * 1024), exitCode };
  }

  async listFiles(): Promise<TutorialFile[]> {
    await this.ensureStarted();
    await this.mkdir();
    const response = await this.shimFetch(`/files?root=${encodeURIComponent(SITE_ROOT)}`);
    if (!response.ok) throw new Error(`Could not list demo files: HTTP ${response.status}.`);
    const body = (await response.json()) as { files?: TutorialFile[] };
    return (body.files ?? []).filter((file) => typeof file.path === "string" && Number.isFinite(file.size)).slice(0, 200);
  }

  async readFile(relativePath: string): Promise<Buffer> {
    await this.ensureStarted();
    const path = `${SITE_ROOT}/${safeRelativePath(relativePath)}`;
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw Object.assign(new Error("Demo file not found."), { status: response.status });
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > 1024 * 1024) throw Object.assign(new Error("Demo file is too large to view."), { status: 413 });
    return data;
  }

  async destroy(): Promise<void> {
    const mock = process.env.AGENTMOM_TUTORIAL_SANDBOX_URL?.trim();
    if (mock) {
      await this.shimFetch("/reset", { method: "POST" }).catch(() => undefined);
      return;
    }
    await this.api("DELETE", `/apps/${this.appName}`).catch((error) => {
      if (!/returned 404/.test(String(error))) throw error;
    });
    this.machineId = undefined;
  }

  private get token(): string {
    return process.env.AGENTMOM_TUTORIAL_SANDBOX_TOKEN?.trim() ||
      createHmac("sha256", this.config.fly.token).update(`tutorial:${this.userId}`).digest("hex");
  }

  private get shimBase(): string {
    return process.env.AGENTMOM_TUTORIAL_SANDBOX_URL?.trim() || `https://${this.appName}.fly.dev`;
  }

  private async start(): Promise<void> {
    if (process.env.AGENTMOM_TUTORIAL_SANDBOX_URL) {
      const health = await this.shimFetch("/health", { timeoutMs: 5_000 });
      if (!health.ok) throw new Error("The test demo sandbox is unavailable.");
      return;
    }
    await this.api("POST", "/apps", { app_name: this.appName, org_slug: this.config.fly.org }).catch((error) => {
      if (!/taken|exists/i.test(String(error))) throw error;
    });
    await this.allocateSharedIp();
    const machines = (await this.api("GET", `/apps/${this.appName}/machines`)) as Array<{ id: string }>;
    if (machines[0]) this.machineId = machines[0].id;
    if (!this.machineId) await this.createMachine();
    if (await this.healthy(1500)) return;
    const requestStart = () => this.api("POST", `/apps/${this.appName}/machines/${this.machineId}/start`, {}).catch((error) => {
      if (!/already started|not stopped|current state/i.test(String(error))) throw error;
    });
    await requestStart();
    const deadline = Date.now() + 90_000;
    let lastStartAttempt = Date.now();
    while (Date.now() < deadline) {
      if (await this.healthy(2000)) return;
      if (Date.now() - lastStartAttempt >= 2_000) {
        const machine = (await this.api("GET", `/apps/${this.appName}/machines/${this.machineId}`).catch(() => undefined)) as
          | { state?: string }
          | undefined;
        if (machine?.state === "stopped" || machine?.state === "suspended") await requestStart();
        lastStartAttempt = Date.now();
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("The temporary Fly sandbox did not become ready.");
  }

  private async createMachine(): Promise<void> {
    const bootstrap = `curl -fsSL ${this.config.fly.shimUrl} -o /tmp/agentmom-shim.mjs && exec node /tmp/agentmom-shim.mjs`;
    const machineConfig = {
      name: "vibe-demo",
      region: this.config.fly.region,
      config: {
        image: this.config.fly.image,
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: this.config.fly.demoMemoryMb },
        env: {
          AGENTMOM_SHIM_TOKEN: this.token,
          AGENTMOM_WORKSPACE: "/workspace",
          AGENTMOM_IDLE_MS: String(this.config.fly.demoIdleMinutes * 60_000),
          AGENTMOM_MAX_LIFETIME_MS: String(this.config.fly.demoMaxMinutes * 60_000),
          AGENTMOM_EXEC_MAX_OUTPUT_BYTES: String(64 * 1024),
          AGENTMOM_ALLOW_SPAWN: "0",
          AGENTMOM_STRICT_FILE_JAIL: "1",
          AGENTMOM_KILL_PROCESS_GROUP: "1",
          HOME: "/workspace"
        },
        init: { exec: ["/bin/bash", "-c", bootstrap] },
        services: [
          {
            protocol: "tcp",
            internal_port: 8080,
            autostart: false,
            autostop: "off",
            ports: [
              { port: 80, handlers: ["http"] },
              { port: 443, handlers: ["tls", "http"] }
            ]
          }
        ],
        restart: { policy: "no" },
        auto_destroy: true
      }
    };
    let machine: { id?: string } | undefined;
    let machineError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        machine = await this.api("POST", `/apps/${this.appName}/machines`, machineConfig);
        break;
      } catch (error) {
        machineError = error;
        if (!/returned 404:/.test(String(error)) || attempt === 9) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
    }
    if (!machine) throw machineError;
    this.machineId = String(machine.id);
  }

  private async mkdir(): Promise<void> {
    const response = await this.shimFetch(`/file?path=${encodeURIComponent(SITE_ROOT)}&op=mkdir`, { method: "POST" });
    if (!response.ok) throw new Error("Could not prepare the demo folder.");
  }

  private async healthy(timeoutMs: number): Promise<boolean> {
    try {
      return (await this.shimFetch("/health", { timeoutMs })).ok;
    } catch {
      return false;
    }
  }

  private async shimFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
    try {
      return await fetch(`${this.shimBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
        signal: init.signal ?? controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${MACHINES_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Fly ${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }

  private async allocateSharedIp(): Promise<void> {
    const response = await fetch(GRAPHQL_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }",
        variables: { input: { appId: this.appName, type: "shared_v4" } }
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = (await response.json()) as { errors?: Array<{ message: string }> };
    const message = payload.errors?.[0]?.message ?? "";
    if (message && !/already|taken/i.test(message)) throw new Error(`Fly IP allocation failed: ${message}`);
  }
}
