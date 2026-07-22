import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AppConfig } from "./config.js";
import { isReservedDeploymentSlug, type DeploymentRouteMode, slugify } from "./deployment-routing.js";
import { runCommand, truncateLog } from "./process-utils.js";
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
const MACHINES_API = "https://api.machines.dev/v1";
const GRAPHQL_API = "https://api.fly.io/graphql";

/**
 * User deployments. Static sites are files on the server's disk (zero
 * execution). Container apps are Fly apps (`am-dep-<slug>`) built remotely
 * and scaled to zero by fly-proxy — no user code ever runs on this server.
 */
export class DeploymentManager {
  private readonly statePath: string;
  private readonly deploymentDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly config: AppConfig) {
    this.deploymentDir = this.config.deploymentDir;
    this.statePath = join(this.deploymentDir, "deployments.json");
    mkdirSync(this.deploymentDir, { recursive: true });
  }

  async list(scope: DeploymentScope = {}): Promise<DeploymentRecord[]> {
    return this.readState()
      .deployments.map((entry) => this.decorate(entry))
      .filter((deployment) => this.matchesScope(deployment, scope))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async isRoutable(slug: string): Promise<boolean> {
    const deployment = this.find(slug);
    return deployment?.status === "running";
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

    if (!this.config.fly.token) {
      throw new Error("Container deployments are unavailable: no Fly token configured");
    }
    const containerPort = input.port ?? 3000;
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new Error(`Invalid container port: ${input.port}`);
    }

    return this.withLock(slug, () => this.publishFlyUnlocked({ ...shared, containerPort }));
  }

  /**
   * A static root is used when explicitly requested via --static, or when the
   * project has no Dockerfile but a conventional directory with index.html.
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
    let existing = this.find(slug);
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
      containerPort: 0,
      staticDir: destDir,
      urlPath: `/deploy/${input.slug}/`,
      status: "running",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastDeployAt: now
    };
    deployment = this.decorate(deployment);
    this.upsert(deployment);
    await this.removeArtifacts(existing, deployment);
    await this.ensureCertificate(input.slug);
    return deployment;
  }

  private async publishFlyUnlocked(input: {
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

    const flyApp = `${this.config.fly.deployAppPrefix}${input.slug}`;
    let deployment: DeploymentRecord = {
      id: existing?.id ?? input.slug,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.displayName,
      projectPath: input.projectPath,
      kind: "container",
      flyApp,
      containerPort: input.containerPort,
      urlPath: `/deploy/${input.slug}/`,
      status: "building",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastDeployAt: now
    };
    if (existing?.status !== "running") {
      this.upsert(deployment);
    }

    const configPath = join(input.projectPath, ".agentmom-deploy.fly.toml");
    try {
      await this.machinesApi("POST", "/apps", { app_name: flyApp, org_slug: this.config.fly.org }).catch((error) => {
        if (!/taken|exists/i.test(String(error))) throw error;
      });

      writeFileSync(configPath, deploymentFlyToml(flyApp, this.config.fly.region, input.containerPort), "utf8");
      const deployResult = await runCommand(
        this.config.fly.flyctl,
        ["deploy", "--app", flyApp, "--config", configPath, "--remote-only", "--yes", "--vm-size", "shared-cpu-1x", "--vm-memory", "256"],
        {
          cwd: input.projectPath,
          env: { FLY_API_TOKEN: this.config.fly.token, FLY_NO_UPDATE_CHECK: "1" }
        }
      );

      deployment = {
        ...deployment,
        status: "running",
        error: undefined,
        buildLog: truncateLog(deployResult.output),
        updatedAt: new Date().toISOString()
      };
      deployment = this.decorate(deployment);
      this.upsert(deployment);
      await this.removeArtifacts(existing, deployment);
      await this.ensureCertificate(input.slug);
      return deployment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (existing?.status === "running") {
        this.upsert({ ...existing, error: message, updatedAt: new Date().toISOString() });
      } else {
        this.upsert({
          ...deployment,
          status: "failed",
          error: truncateLog(message, 8000),
          updatedAt: new Date().toISOString()
        });
      }
      throw error;
    } finally {
      rmSync(configPath, { force: true });
    }
  }

  async remove(slug: string, scope: DeploymentScope = {}): Promise<boolean> {
    return this.withLock(slug, async () => {
      const deployment = this.find(slug, scope);
      if (!deployment) return false;
      await this.removeArtifacts(deployment);
      await this.removeCertificate(slug);
      const state = this.readState();
      state.deployments = state.deployments.filter((entry) => entry.slug !== slug);
      this.writeState(state);
      return true;
    });
  }

  async logs(slug: string, tail = 200, scope: DeploymentScope = {}): Promise<string> {
    const deployment = this.find(slug, scope);
    if (!deployment) throw new Error(`Unknown deployment: ${slug}`);
    if (deploymentKind(deployment) === "static") {
      return "Static deployment; there is no runtime process or log.";
    }
    if (deployment.status !== "running" || !deployment.flyApp) {
      return [deployment.error, deployment.buildLog].filter(Boolean).join("\n").trim();
    }
    const result = await runCommand(this.config.fly.flyctl, ["logs", "--app", deployment.flyApp, "--no-tail"], {
      allowFailure: true,
      env: { FLY_API_TOKEN: this.config.fly.token, FLY_NO_UPDATE_CHECK: "1" }
    });
    const lines = result.output.trim().split("\n");
    return lines.slice(-Math.max(1, Math.min(tail, 1000))).join("\n");
  }

  async fetch(
    slug: string,
    request: PreviewFetchRequest,
    mode: DeploymentRouteMode = "path"
  ): Promise<PreviewFetchResponse> {
    const deployment = this.find(slug);
    if (!deployment) {
      return textResponse(404, `Unknown deployment: ${slug}`);
    }
    if (deployment.status !== "running") {
      return textResponse(503, `Deployment is ${deployment.status}`);
    }

    if (deploymentKind(deployment) === "static") {
      return this.serveStatic(deployment, request, mode);
    }

    // fly-proxy wakes a scaled-to-zero app on this request (a few seconds
    // after idle); no wake bookkeeping on our side.
    const body =
      request.body && request.method !== "GET" && request.method !== "HEAD"
        ? (new Uint8Array(request.body) as BodyInit)
        : undefined;

    let response: Response;
    try {
      response = await fetch(`https://${deployment.flyApp}.fly.dev${request.path}`, {
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

  // ---- Fly plumbing ---------------------------------------------------------

  private async machinesApi(method: string, path: string, body?: unknown): Promise<any> {
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

  private async graphql(query: string, variables: Record<string, unknown>): Promise<{ errors?: Array<{ message: string }> }> {
    const response = await fetch(GRAPHQL_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.fly.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    return (await response.json()) as { errors?: Array<{ message: string }> };
  }

  /** slug.agentmom.xyz terminates TLS at the server app's Fly edge. */
  private async ensureCertificate(slug: string): Promise<void> {
    const { serverApp, token } = this.config.fly;
    if (!serverApp || !token || !this.config.deploymentBaseDomain) return;
    const hostname = `${slug}.${this.config.deploymentBaseDomain}`;
    const payload = await this.graphql(
      "mutation($input: AddCertificateInput!) { addCertificate(input: $input) { certificate { id } } }",
      { input: { appId: serverApp, hostname } }
    ).catch(() => undefined);
    const message = payload?.errors?.[0]?.message ?? "";
    if (message && !/already/i.test(message)) {
      console.warn(`certificate for ${hostname}: ${message}`);
    }
  }

  private async removeCertificate(slug: string): Promise<void> {
    const { serverApp, token } = this.config.fly;
    if (!serverApp || !token || !this.config.deploymentBaseDomain) return;
    await this.graphql(
      "mutation($input: DeleteCertificateInput!) { deleteCertificate(input: $input) { app { id } } }",
      { input: { appId: serverApp, hostname: `${slug}.${this.config.deploymentBaseDomain}` } }
    ).catch(() => undefined);
  }

  // ---- Shared internals -------------------------------------------------------

  private find(slug: string, scope: DeploymentScope = {}): DeploymentRecord | undefined {
    const deployment = this.readState().deployments.find((entry) => entry.slug === slug);
    if (!deployment || !this.matchesScope(deployment, scope)) return undefined;
    return this.decorate(deployment);
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

  /** Delete a deployment's leftovers, keeping anything the replacement still uses. */
  private async removeArtifacts(target: DeploymentRecord | undefined, replacement?: DeploymentRecord): Promise<void> {
    if (!target) return;
    if (target.flyApp && target.flyApp !== replacement?.flyApp) {
      await this.machinesApi("DELETE", `/apps/${target.flyApp}`).catch(() => {});
    }
    if (
      target.staticDir &&
      target.staticDir !== replacement?.staticDir &&
      this.pathIsInside(target.staticDir, join(this.deploymentDir, "static"))
    ) {
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

function deploymentFlyToml(app: string, region: string, port: number): string {
  return [
    `app = "${app}"`,
    `primary_region = "${region}"`,
    "",
    "[env]",
    `  PORT = "${port}"`,
    "",
    "[http_service]",
    `  internal_port = ${port}`,
    "  force_https = true",
    '  auto_stop_machines = "stop"',
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    ""
  ].join("\n");
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
    if (deployment.flyApp && url.hostname === `${deployment.flyApp}.fly.dev`) {
      headers.location =
        mode === "path" || !deployment.urlHost
          ? `${prefix}${url.pathname}${url.search}${url.hash}`
          : `https://${deployment.urlHost}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative redirects are already relative to the deployment prefix.
  }
}
