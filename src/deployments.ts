import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AppConfig } from "./config.js";
import { isReservedDeploymentSlug, type DeploymentRouteMode, slugify } from "./deployment-routing.js";
import { allocatePort, releasePort, reservePort, runCommand, sleep, truncateLog } from "./process-utils.js";
import type { DeploymentRecord } from "./types.js";
import type { PreviewFetchRequest, PreviewFetchResponse } from "./previews.js";
import {
  cleanResponseHeaders,
  rewriteRootRelativeText,
  shouldRewriteText,
  textResponse
} from "./proxy-utils.js";

type DeploymentState = {
  deployments: DeploymentRecord[];
};

export type DeploymentScope = {
  workspaceId?: string;
  workspaceDirName?: string;
};

export type PublishDeploymentInput = {
  path: string;
  slug?: string;
  port?: number;
  staticDir?: string;
  workspaceId?: string;
  workspaceDirName?: string;
};

const MAX_STATIC_BYTES = 256 * 1024 * 1024;
const MAX_STATIC_FILES = 20_000;
const STATIC_SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const STATIC_ROOT_CANDIDATES = [".", "dist", "build", "out", "public", "_site"];
const IDLE_SWEEP_INTERVAL_MS = 60_000;

export class DeploymentManager {
  private readonly statePath: string;
  private readonly deploymentDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly lastActivity = new Map<string, number>();

  constructor(private readonly config: AppConfig) {
    this.deploymentDir = this.config.deploymentDir;
    this.statePath = join(this.deploymentDir, "deployments.json");
    mkdirSync(this.deploymentDir, { recursive: true });
    for (const deployment of this.readState().deployments) {
      if (deploymentKind(deployment) === "container") reservePort(deployment.hostPort);
    }
    if (this.config.deploy.idleMinutes > 0) {
      setInterval(() => {
        void this.sweepIdle().catch(() => {});
      }, IDLE_SWEEP_INTERVAL_MS).unref();
    }
  }

  async list(scope: DeploymentScope = {}): Promise<DeploymentRecord[]> {
    const deployments = await Promise.all(this.readState().deployments.map((entry) => this.reconcile(entry)));
    return deployments
      .filter((deployment) => this.matchesScope(deployment, scope))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async isRoutable(slug: string): Promise<boolean> {
    const deployment = await this.find(slug);
    return deployment?.status === "running" || deployment?.status === "suspended";
  }

  async publish(input: PublishDeploymentInput): Promise<DeploymentRecord> {
    const projectPath = this.resolveProjectPath(input.path);
    const staticRoot = this.resolveStaticRoot(projectPath, input.staticDir);
    if (!staticRoot && !existsSync(join(projectPath, "Dockerfile"))) {
      throw new Error(
        `Nothing deployable found in ${projectPath}: no Dockerfile and no static site (index.html). ` +
          `Add a Dockerfile for an app, or pass --static <dir> for a static site.`
      );
    }

    const slug = slugify(input.slug || basename(projectPath));
    if (!slug) throw new Error("Deployment slug is required");
    if (isReservedDeploymentSlug(slug)) throw new Error(`Deployment slug is reserved: ${slug}`);

    this.enforceQuota(slug, { workspaceId: input.workspaceId, workspaceDirName: input.workspaceDirName });

    const shared = {
      projectPath,
      slug,
      displayName: input.slug?.trim() || basename(projectPath),
      workspaceId: input.workspaceId,
      workspaceDirName: input.workspaceDirName
    };

    if (staticRoot) {
      return this.withLock(slug, () => this.publishStaticUnlocked({ ...shared, staticRoot }));
    }

    const containerPort = input.port ?? 3000;
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new Error(`Invalid container port: ${input.port}`);
    }

    return this.withLock(slug, () => this.publishUnlocked({ ...shared, containerPort }));
  }

  /**
   * A static root is used when explicitly requested via --static, or when the project
   * has no Dockerfile but a conventional directory containing index.html.
   */
  private resolveStaticRoot(projectPath: string, staticDir: string | undefined): string | undefined {
    if (staticDir !== undefined) {
      const trimmed = staticDir.trim().replace(/^\/+/, "");
      const root = resolve(projectPath, trimmed || ".");
      if (!this.pathIsInside(root, projectPath)) {
        throw new Error("Static directory must be inside the project directory");
      }
      if (!existsSync(join(root, "index.html"))) {
        throw new Error(`Static directory has no index.html: ${root}`);
      }
      return root;
    }

    if (existsSync(join(projectPath, "Dockerfile"))) return undefined;
    for (const candidate of STATIC_ROOT_CANDIDATES) {
      const root = resolve(projectPath, candidate);
      if (existsSync(join(root, "index.html"))) return root;
    }
    return undefined;
  }

  private enforceQuota(slug: string, scope: DeploymentScope): void {
    const max = this.config.deploy.maxPerWorkspace;
    if (max <= 0) return;
    const owned = this.readState().deployments.filter((entry) => this.matchesScope(entry, scope));
    if (owned.some((entry) => entry.slug === slug)) return; // redeploying an existing slug is always allowed
    if (owned.length >= max) {
      throw new Error(
        `Deployment limit reached (${max} per workspace). Remove an old deployment first, or redeploy an existing slug.`
      );
    }
  }

  private async claimSlug(slug: string, scope: DeploymentScope): Promise<DeploymentRecord | undefined> {
    let existing = await this.find(slug);
    if (existing && scope.workspaceId && !existing.workspaceId) {
      if (this.matchesScope(existing, scope)) {
        existing = { ...existing, workspaceId: scope.workspaceId };
      } else if (existing.status === "running") {
        throw new Error(`Deployment slug is already used by a legacy deployment: ${slug}`);
      } else {
        await this.removeArtifacts(existing);
        this.deleteRecord(existing.slug);
        existing = undefined;
      }
    }
    if (!this.matchesScope(existing, scope)) {
      throw new Error(`Deployment slug is already used by another workspace: ${slug}`);
    }
    return existing;
  }

  private async publishStaticUnlocked(input: {
    projectPath: string;
    slug: string;
    staticRoot: string;
    displayName: string;
    workspaceId?: string;
    workspaceDirName?: string;
  }): Promise<DeploymentRecord> {
    const now = new Date().toISOString();
    const existing = await this.claimSlug(input.slug, {
      workspaceId: input.workspaceId,
      workspaceDirName: input.workspaceDirName
    });

    const version = Date.now().toString(36);
    const destDir = join(this.deploymentDir, "static", input.slug, version);
    copyStaticSite(input.staticRoot, destDir);

    let deployment: DeploymentRecord = {
      id: existing?.id ?? input.slug,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.displayName,
      projectPath: input.projectPath,
      kind: "static",
      image: "",
      container: "",
      containerPort: 0,
      hostPort: 0,
      staticDir: destDir,
      urlPath: `/deploy/${input.slug}/`,
      status: "running",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastDeployAt: now
    };
    deployment = this.decorate(deployment);
    this.upsert(deployment);
    await this.removeArtifacts(existing);
    return deployment;
  }

  private async publishUnlocked(input: {
    projectPath: string;
    slug: string;
    containerPort: number;
    displayName: string;
    workspaceId?: string;
    workspaceDirName?: string;
  }): Promise<DeploymentRecord> {
    const now = new Date().toISOString();
    const existing = await this.claimSlug(input.slug, {
      workspaceId: input.workspaceId,
      workspaceDirName: input.workspaceDirName
    });
    const hostPort = await allocatePort();
    reservePort(hostPort);
    const version = Date.now().toString(36);
    const image = `localhost/agentmom/${input.slug}:${version}`;
    const container = `agentmom-${input.slug}-${version}`;

    let deployment: DeploymentRecord = {
      id: existing?.id ?? input.slug,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.displayName,
      projectPath: input.projectPath,
      kind: "container",
      image,
      container,
      containerPort: input.containerPort,
      hostPort,
      urlPath: `/deploy/${input.slug}/`,
      status: "building",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastDeployAt: now
    };
    if (existing?.status !== "running") {
      this.upsert(deployment);
    }

    try {
      const build = await runCommand(this.config.podman.command, ["build", "-t", image, "."], { cwd: input.projectPath });
      deployment = {
        ...deployment,
        buildLog: truncateLog(build.output),
        updatedAt: new Date().toISOString()
      };
      if (existing?.status !== "running") {
        this.upsert(deployment);
      }

      const run = await runCommand(this.config.podman.command, [
        "run",
        "-d",
        "--name",
        container,
        "--log-driver",
        "k8s-file",
        "--memory",
        `${this.config.deploy.memoryMb}m`,
        "--cpus",
        String(this.config.deploy.cpus),
        "--pids-limit",
        String(this.config.deploy.pidsLimit),
        "--restart",
        "on-failure:3",
        "--label",
        `agentmom.deployment=${input.slug}`,
        "--label",
        `agentmom.version=${version}`,
        "-e",
        `PORT=${input.containerPort}`,
        "-p",
        `127.0.0.1:${hostPort}:${input.containerPort}`,
        image
      ]);
      await this.waitUntilReady(hostPort, container);

      deployment = {
        ...deployment,
        status: "running",
        error: undefined,
        buildLog: truncateLog(`${deployment.buildLog ?? ""}\n${run.output}`.trim()),
        updatedAt: new Date().toISOString()
      };
      deployment = this.decorate(deployment);
      this.upsert(deployment);
      this.lastActivity.set(deployment.slug, Date.now());
      await this.removeArtifacts(existing);
      return deployment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.removeContainerAndImage({ container, image });
      releasePort(hostPort);
      if (existing?.status === "running") {
        this.upsert({
          ...existing,
          error: message,
          updatedAt: new Date().toISOString()
        });
      } else {
        deployment = {
          ...deployment,
          status: "failed",
          error: message,
          updatedAt: new Date().toISOString()
        };
        this.upsert(deployment);
      }
      throw error;
    }
  }

  async remove(slug: string, scope: DeploymentScope = {}): Promise<boolean> {
    return this.withLock(slug, async () => {
      const deployment = await this.find(slug, scope);
      if (!deployment) return false;
      await this.removeArtifacts(deployment);
      this.lastActivity.delete(slug);
      const state = this.readState();
      state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
      this.writeState(state);
      return true;
    });
  }

  async logs(slug: string, tail = 200, scope: DeploymentScope = {}): Promise<string> {
    const deployment = await this.find(slug, scope);
    if (!deployment) throw new Error(`Unknown deployment: ${slug}`);
    if (deploymentKind(deployment) === "static") {
      return "Static deployment; there is no runtime process or log.";
    }
    if (deployment.status !== "running" && deployment.status !== "suspended") {
      return [deployment.error, deployment.buildLog].filter(Boolean).join("\n").trim();
    }
    const result = await runCommand(
      this.config.podman.command,
      ["logs", "--tail", String(Math.max(1, Math.min(tail, 1000))), deployment.container],
      { allowFailure: true }
    );
    return result.output.trim();
  }

  /** Stop container deployments that have not served a request within the idle window. */
  async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.deploy.idleMinutes * 60_000;
    for (const record of this.readState().deployments) {
      if (deploymentKind(record) === "static" || record.status !== "running") continue;
      if (this.lastActivityAt(record) > cutoff) continue;
      await this.withLock(record.slug, async () => {
        const current = this.readState().deployments.find((entry) => entry.slug === record.slug);
        if (!current || current.status !== "running") return;
        if (this.lastActivityAt(current) > cutoff) return;
        await runCommand(this.config.podman.command, ["stop", "-t", "5", current.container], { allowFailure: true });
        this.upsert({
          ...current,
          status: "suspended",
          lastRequestAt: new Date(this.lastActivityAt(current) || Date.now()).toISOString(),
          updatedAt: new Date().toISOString()
        });
      });
    }
  }

  private lastActivityAt(record: DeploymentRecord): number {
    const persisted = Date.parse(record.lastRequestAt ?? "") || Date.parse(record.updatedAt) || 0;
    return Math.max(this.lastActivity.get(record.slug) ?? 0, persisted);
  }

  /** Start a suspended deployment's container and wait for it to serve. */
  private async wake(slug: string): Promise<DeploymentRecord | undefined> {
    return this.withLock(slug, async () => {
      const current = await this.find(slug);
      if (!current || current.status !== "suspended") return current;
      try {
        await runCommand(this.config.podman.command, ["start", current.container]);
        await this.waitUntilReady(current.hostPort, current.container);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: DeploymentRecord = {
          ...current,
          status: "stopped",
          error: `Wake from suspend failed: ${truncateLog(message, 4000)}`,
          updatedAt: new Date().toISOString()
        };
        this.upsert(failed);
        return failed;
      }
      const woken: DeploymentRecord = {
        ...current,
        status: "running",
        error: undefined,
        lastRequestAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.upsert(woken);
      this.lastActivity.set(slug, Date.now());
      return woken;
    });
  }

  async fetch(
    slug: string,
    request: PreviewFetchRequest,
    mode: DeploymentRouteMode = "path"
  ): Promise<PreviewFetchResponse> {
    let deployment = await this.find(slug);
    if (!deployment) {
      return textResponse(404, `Unknown deployment: ${slug}`);
    }

    if (deploymentKind(deployment) === "static") {
      if (deployment.status !== "running") {
        return textResponse(503, `Deployment is ${deployment.status}`);
      }
      return this.serveStatic(deployment, request, mode);
    }

    this.lastActivity.set(slug, Date.now());
    if (deployment.status === "suspended") {
      deployment = (await this.wake(slug)) ?? deployment;
    }
    if (deployment.status !== "running") {
      return textResponse(503, `Deployment is ${deployment.status}`);
    }

    const body =
      request.body && request.method !== "GET" && request.method !== "HEAD"
        ? (new Uint8Array(request.body) as BodyInit)
        : undefined;

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${deployment.hostPort}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body,
        redirect: "manual"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResponse(502, `Deployment proxy failed: ${message}`);
    }

    return rewriteDeploymentResponse(
      deployment,
      {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer())
      },
      mode
    );
  }

  private async find(slug: string, scope: DeploymentScope = {}): Promise<DeploymentRecord | undefined> {
    const deployment = this.readState().deployments.find((entry) => entry.slug === slug);
    if (!deployment || !this.matchesScope(deployment, scope)) return undefined;
    return this.reconcile(deployment);
  }

  private matchesScope(deployment: DeploymentRecord | undefined, scope: DeploymentScope): boolean {
    if (!deployment) return true;
    if (!scope.workspaceId) return true;
    if (deployment.workspaceId) return deployment.workspaceId === scope.workspaceId;
    if (!scope.workspaceDirName) return false;
    return this.projectPathBelongsToWorkspaceDir(deployment.projectPath, scope.workspaceDirName);
  }

  private upsert(deployment: DeploymentRecord): void {
    const state = this.readState();
    state.deployments = [this.decorate(deployment), ...state.deployments.filter((entry) => entry.slug !== deployment.slug)];
    this.writeState(state);
  }

  private deleteRecord(slug: string): void {
    const state = this.readState();
    state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
    this.writeState(state);
  }

  private decorate(deployment: DeploymentRecord): DeploymentRecord {
    const baseDomain = this.config.deploymentBaseDomain;
    const urlHost = baseDomain ? `${deployment.slug}.${baseDomain}` : undefined;
    return {
      ...deployment,
      urlPath: `/deploy/${deployment.slug}/`,
      urlHost,
      url: urlHost ? `https://${urlHost}/` : `/deploy/${deployment.slug}/`
    };
  }

  private async reconcile(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    const decorated = this.decorate(deployment);
    if (deploymentKind(decorated) === "static" || decorated.status !== "running") return decorated;

    const state = await this.containerState(decorated.container);
    if (state === "running") return decorated;

    if (state === "stopped") {
      // The container exists but is not running (host reboot, crash past the retry
      // limit, manual stop). Treat it as suspended so the next request wakes it.
      const suspended: DeploymentRecord = {
        ...decorated,
        status: "suspended",
        updatedAt: new Date().toISOString()
      };
      this.upsert(suspended);
      return suspended;
    }

    const stopped: DeploymentRecord = {
      ...decorated,
      status: "stopped",
      error: "Container is not running",
      updatedAt: new Date().toISOString()
    };
    this.upsert(stopped);
    return stopped;
  }

  private async containerState(container: string): Promise<"running" | "stopped" | "missing"> {
    const result = await runCommand(
      this.config.podman.command,
      ["container", "inspect", "--format", "{{.State.Running}}", container],
      { allowFailure: true }
    );
    if (result.exitCode !== 0) return "missing";
    return result.output.trim() === "true" ? "running" : "stopped";
  }

  private async removeArtifacts(target: DeploymentRecord | undefined): Promise<void> {
    if (!target) return;
    await this.removeContainerAndImage(target);
    if (deploymentKind(target) === "container") releasePort(target.hostPort);
    if (target.staticDir && this.pathIsInside(target.staticDir, join(this.deploymentDir, "static"))) {
      rmSync(target.staticDir, { recursive: true, force: true });
    }
  }

  private serveStatic(
    deployment: DeploymentRecord,
    request: PreviewFetchRequest,
    mode: DeploymentRouteMode
  ): PreviewFetchResponse {
    const root = deployment.staticDir;
    if (!root || !existsSync(root)) {
      return textResponse(503, "Static deployment files are missing; redeploy the site.");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Static deployments only serve GET requests");
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(request.path.split("?")[0].split("#")[0]);
    } catch {
      return textResponse(400, "Bad request path");
    }

    const filePath = resolveStaticFile(root, pathname);
    if (!filePath) {
      return textResponse(404, "Not found");
    }

    const body = readFileSync(filePath);
    return rewriteDeploymentResponse(
      deployment,
      {
        status: 200,
        headers: {
          "content-type": contentTypeFor(filePath),
          "content-length": String(body.byteLength),
          "cache-control": "no-cache"
        },
        body
      },
      mode
    );
  }

  private async waitUntilReady(hostPort: number, container: string): Promise<void> {
    const timeoutMs = Number.parseInt(process.env.AGENTMOM_DEPLOYMENT_READY_TIMEOUT_MS ?? "30000", 10);
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 30_000);
    let lastError = "no response yet";

    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(`http://127.0.0.1:${hostPort}/`, {
          method: "GET",
          signal: controller.signal
        });
        await response.arrayBuffer();
        if (response.status < 500) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }
      await sleep(250);
    }

    const logs = await runCommand(this.config.podman.command, ["logs", "--tail", "80", container], { allowFailure: true });
    throw new Error(
      `Deployment did not become ready on 127.0.0.1:${hostPort}: ${lastError}\n${truncateLog(logs.output.trim(), 4000)}`
    );
  }

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    if (!trimmed) throw new Error("Deployment path is required");
    const projectPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.config.agentCwd, trimmed);
    if (this.pathIsInside(projectPath, this.config.projectsDir) || this.pathIsInsideWorkspaceProjects(projectPath)) {
      return projectPath;
    }
    throw new Error("Deployment path must be inside a workspace projects directory");
  }

  private readState(): DeploymentState {
    if (!existsSync(this.statePath)) return { deployments: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as DeploymentState;
      return { deployments: Array.isArray(parsed.deployments) ? parsed.deployments : [] };
    } catch {
      return { deployments: [] };
    }
  }

  private projectPathBelongsToWorkspaceDir(projectPath: string, workspaceDirName: string): boolean {
    const projectsDir = resolve(this.config.workspaceRoot, workspaceDirName, "projects");
    return this.pathIsInside(projectPath, projectsDir);
  }

  private pathIsInside(path: string, root: string): boolean {
    const pathRelative = relative(resolve(root), resolve(path));
    return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
  }

  private pathIsInsideWorkspaceProjects(projectPath: string): boolean {
    const projectRelative = relative(resolve(this.config.workspaceRoot), resolve(projectPath));
    if (!projectRelative || projectRelative.startsWith("..") || isAbsolute(projectRelative)) return false;

    const [, directory] = projectRelative.split(/[\\/]+/);
    return directory === "projects";
  }

  private writeState(state: DeploymentState): void {
    mkdirSync(this.deploymentDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.statePath);
  }

  private async removeContainerAndImage(target: { container?: string; image?: string } | undefined): Promise<void> {
    if (!target) return;
    if (target.container) {
      await runCommand(this.config.podman.command, ["rm", "-f", target.container], { allowFailure: true });
    }
    if (target.image) {
      await runCommand(this.config.podman.command, ["rmi", "-f", target.image], { allowFailure: true });
    }
  }

  private async withLock<T>(slug: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(slug) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const lock = previous.catch(() => undefined).then(() => next);
    this.locks.set(slug, lock);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(slug) === lock) {
        this.locks.delete(slug);
      }
    }
  }
}

function deploymentKind(record: DeploymentRecord): "container" | "static" {
  return record.kind ?? "container";
}

function copyStaticSite(src: string, dest: string): void {
  let bytes = 0;
  let files = 0;
  try {
    cpSync(src, dest, {
      recursive: true,
      filter: (source) => {
        const stats = lstatSync(source);
        if (stats.isSymbolicLink()) return false;
        if (stats.isDirectory()) return !STATIC_SKIPPED_DIRS.has(basename(source));
        files += 1;
        bytes += stats.size;
        if (files > MAX_STATIC_FILES) {
          throw new Error(`Static site has too many files (limit ${MAX_STATIC_FILES})`);
        }
        if (bytes > MAX_STATIC_BYTES) {
          throw new Error(`Static site is too large (limit ${Math.round(MAX_STATIC_BYTES / 1024 / 1024)} MB)`);
        }
        return true;
      }
    });
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

function resolveStaticFile(root: string, pathname: string): string | undefined {
  const clean = normalize(pathname).replaceAll(/^[/\\]+/g, "");
  const candidate = resolve(root, clean === "" || clean === "." ? "index.html" : clean);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return undefined;

  if (existsSync(candidate)) {
    const stats = statSync(candidate);
    if (stats.isFile()) return candidate;
    if (stats.isDirectory()) {
      const index = join(candidate, "index.html");
      return existsSync(index) && statSync(index).isFile() ? index : undefined;
    }
    return undefined;
  }

  // SPA-style fallback: extensionless paths render the site shell.
  if (!extname(candidate)) {
    const index = join(root, "index.html");
    if (existsSync(index) && statSync(index).isFile()) return index;
  }
  return undefined;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json"
};

function contentTypeFor(filePath: string): string {
  return STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function rewriteDeploymentResponse(
  deployment: DeploymentRecord,
  response: PreviewFetchResponse,
  mode: DeploymentRouteMode
): PreviewFetchResponse {
  const headers = cleanResponseHeaders(response.headers, { stripSetCookie: true });
  rewriteLocationHeader(headers, deployment, mode);
  const contentType = headers["content-type"] ?? "";
  if (mode !== "path" || !shouldRewriteText(contentType)) {
    return { ...response, headers };
  }

  const body = Buffer.from(
    rewriteRootRelativeText(response.body.toString("utf8"), `/deploy/${deployment.slug}/`, contentType),
    "utf8"
  );
  headers["content-length"] = String(body.byteLength);
  return {
    status: response.status,
    headers,
    body
  };
}

function rewriteLocationHeader(
  headers: Record<string, string>,
  deployment: DeploymentRecord,
  mode: DeploymentRouteMode
): void {
  const location = headers.location;
  if (!location) return;

  const prefix = mode === "path" ? `/deploy/${deployment.slug}` : "";
  if (location.startsWith("/")) {
    headers.location = mode === "path" ? `${prefix}${location}` : location;
    return;
  }

  try {
    const url = new URL(location);
    if (url.hostname === "127.0.0.1" && url.port === String(deployment.hostPort)) {
      headers.location =
        mode === "path" || !deployment.urlHost
          ? `${prefix}${url.pathname}${url.search}${url.hash}`
          : `https://${deployment.urlHost}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative redirects like "next" are already relative to /deploy/<slug>/.
  }
}
