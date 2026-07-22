import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const workspace = mkdtempSync(join(tmpdir(), "agentmom-deploy-"));
const agentCwd = join(workspace, "projects");
const projectPath = join(agentCwd, "demo");

process.env.AGENTMOM_WORKSPACE = workspace;
process.env.AGENTMOM_AGENT_CWD = agentCwd;
process.env.AGENTMOM_DEPLOYMENT_DIR = join(workspace, ".agentmom", "deployments");
process.env.AGENTMOM_DEPLOYMENT_BASE_DOMAIN = "mom-stage.agentmom.xyz";
process.env.AGENTMOM_DEPLOYMENT_READY_TIMEOUT_MS = "2500";
process.env.AGENTMOM_PODMAN_COMMAND ??= "podman";
process.env.AGENTMOM_DEPLOY_MAX_PER_WORKSPACE = "2";
process.env.AGENTMOM_DEPLOY_IDLE_MINUTES = "0"; // sweepIdle() is invoked manually below

mkdirSync(projectPath, { recursive: true });

writeApp("DEPLOY_SMOKE_OK");
writeValidDockerfile();

const { loadConfig } = await import("../src/config.js");
const { deploymentSlugFromHost, isAllowedDeploymentDomain } = await import("../src/deployment-routing.js");
const { DeploymentManager } = await import("../src/deployments.js");

const manager = new DeploymentManager(loadConfig());
let deployedSlug: string | undefined;

try {
  const deployment = await manager.publish({ path: "demo", slug: "smoke-demo", port: 3000 });
  deployedSlug = deployment.slug;
  if (deployment.url !== "https://smoke-demo.mom-stage.agentmom.xyz/") {
    throw new Error(`Unexpected deployment URL: ${deployment.url}`);
  }
  if (deploymentSlugFromHost("smoke-demo.mom-stage.agentmom.xyz", "mom-stage.agentmom.xyz") !== "smoke-demo") {
    throw new Error("Deployment host parser did not recognize slug host");
  }
  if (deploymentSlugFromHost("mom-stage.agentmom.xyz", "mom-stage.agentmom.xyz") !== undefined) {
    throw new Error("Deployment host parser should not route the base app host");
  }
  if (!isAllowedDeploymentDomain("smoke-demo.mom-stage.agentmom.xyz", "mom-stage.agentmom.xyz")) {
    throw new Error("TLS ask helper did not allow deployment host");
  }
  if (isAllowedDeploymentDomain("nested.smoke-demo.mom-stage.agentmom.xyz", "mom-stage.agentmom.xyz")) {
    throw new Error("TLS ask helper should not allow nested deployment hosts");
  }

  const page = await waitForPage(() => manager.fetch(deployment.slug, {
    method: "GET",
    path: "/",
    headers: {}
  }));
  const html = page.body.toString("utf8");
  if (page.status !== 200 || !html.includes("DEPLOY_SMOKE_OK")) {
    throw new Error(`Unexpected deploy response ${page.status}: ${html.slice(0, 300)}`);
  }
  if (!html.includes('/deploy/smoke-demo/asset.css')) {
    throw new Error(`Deployment proxy did not rewrite root asset paths: ${html.slice(0, 300)}`);
  }

  const redirect = await manager.fetch(deployment.slug, {
    method: "GET",
    path: "/redirect",
    headers: {}
  });
  if (redirect.status !== 302 || redirect.headers.location !== "/deploy/smoke-demo/final") {
    throw new Error(`Deployment proxy did not rewrite redirects: ${JSON.stringify(redirect.headers)}`);
  }
  const hostPage = await manager.fetch(deployment.slug, {
    method: "GET",
    path: "/",
    headers: {}
  }, "host");
  const hostHtml = hostPage.body.toString("utf8");
  if (hostPage.status !== 200 || !hostHtml.includes('href="/asset.css"')) {
    throw new Error(`Host deployment proxy unexpectedly rewrote root paths: ${hostHtml.slice(0, 300)}`);
  }
  const hostRedirect = await manager.fetch(deployment.slug, {
    method: "GET",
    path: "/redirect",
    headers: {}
  }, "host");
  if (hostRedirect.status !== 302 || hostRedirect.headers.location !== "/final") {
    throw new Error(`Host deployment proxy unexpectedly rewrote root redirects: ${JSON.stringify(hostRedirect.headers)}`);
  }

  const logs = await manager.logs(deployment.slug, 50);
  if (!logs.includes("smoke app listening")) {
    throw new Error(`Unexpected deploy logs: ${logs.slice(0, 300)}`);
  }

  writeBrokenDockerfile();
  let failedRedeploy = false;
  try {
    await manager.publish({ path: "demo", slug: "smoke-demo", port: 3000 });
  } catch {
    failedRedeploy = true;
  }
  if (!failedRedeploy) {
    throw new Error("Broken redeploy unexpectedly succeeded");
  }

  const preserved = (await manager.list()).find((entry) => entry.slug === deployment.slug);
  if (!preserved || preserved.status !== "running") {
    throw new Error(`Failed redeploy did not preserve running state: ${JSON.stringify(preserved)}`);
  }
  if (preserved.container !== deployment.container || preserved.hostPort !== deployment.hostPort) {
    throw new Error(`Failed redeploy changed the active deployment: ${JSON.stringify(preserved)}`);
  }
  const preservedPage = await manager.fetch(deployment.slug, {
    method: "GET",
    path: "/",
    headers: {}
  });
  if (!preservedPage.body.toString("utf8").includes("DEPLOY_SMOKE_OK")) {
    throw new Error(`Preserved deployment stopped serving: ${preservedPage.body.toString("utf8").slice(0, 300)}`);
  }

  writeWrongPortDockerfile();
  let failedRuntimeRedeploy = false;
  try {
    await manager.publish({ path: "demo", slug: "smoke-demo", port: 3000 });
  } catch {
    failedRuntimeRedeploy = true;
  }
  if (!failedRuntimeRedeploy) {
    throw new Error("Wrong-port redeploy unexpectedly succeeded");
  }

  const runtimePreserved = (await manager.list()).find((entry) => entry.slug === deployment.slug);
  if (!runtimePreserved || runtimePreserved.status !== "running") {
    throw new Error(`Runtime failed redeploy did not preserve running state: ${JSON.stringify(runtimePreserved)}`);
  }
  if (runtimePreserved.container !== deployment.container || runtimePreserved.hostPort !== deployment.hostPort) {
    throw new Error(`Runtime failed redeploy changed the active deployment: ${JSON.stringify(runtimePreserved)}`);
  }

  writeApp("DEPLOY_SMOKE_OK_V2");
  writeValidDockerfile();
  const redeployed = await manager.publish({ path: "demo", slug: "smoke-demo", port: 3000 });
  const redeployedPage = await waitForPage(() => manager.fetch(redeployed.slug, {
    method: "GET",
    path: "/",
    headers: {}
  }), "DEPLOY_SMOKE_OK_V2");
  if (!redeployedPage.body.toString("utf8").includes("DEPLOY_SMOKE_OK_V2")) {
    throw new Error("Redeployed app did not serve updated content");
  }
  await expectMissing(["container", "exists", deployment.container], "old deployment container still exists");
  await expectMissing(["image", "exists", deployment.image], "old deployment image still exists");

  // --- Static fast path ---
  const sitePath = join(agentCwd, "site");
  mkdirSync(join(sitePath, "sub"), { recursive: true });
  writeFileSync(join(sitePath, "index.html"), '<link href="/style.css"><h1>STATIC_SMOKE_OK</h1>', "utf8");
  writeFileSync(join(sitePath, "style.css"), "h1 { color: red; }", "utf8");
  writeFileSync(join(sitePath, "sub", "index.html"), "<p>SUB_PAGE</p>", "utf8");

  const staticDeployment = await manager.publish({ path: "site", slug: "smoke-static" });
  if (staticDeployment.kind !== "static" || staticDeployment.status !== "running") {
    throw new Error(`Static deploy did not run as static: ${JSON.stringify(staticDeployment)}`);
  }
  const staticPage = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  const staticHtml = staticPage.body.toString("utf8");
  if (staticPage.status !== 200 || !staticHtml.includes("STATIC_SMOKE_OK")) {
    throw new Error(`Static page failed: ${staticPage.status} ${staticHtml.slice(0, 200)}`);
  }
  if (!staticHtml.includes("/deploy/smoke-static/style.css")) {
    throw new Error(`Static proxy did not rewrite root asset paths: ${staticHtml.slice(0, 200)}`);
  }
  const css = await manager.fetch("smoke-static", { method: "GET", path: "/style.css", headers: {} });
  if (css.status !== 200 || !css.headers["content-type"]?.startsWith("text/css")) {
    throw new Error(`Static css wrong: ${css.status} ${css.headers["content-type"]}`);
  }
  const subPage = await manager.fetch("smoke-static", { method: "GET", path: "/sub/", headers: {} });
  if (subPage.status !== 200 || !subPage.body.toString("utf8").includes("SUB_PAGE")) {
    throw new Error(`Static directory index failed: ${subPage.status}`);
  }
  const spaFallback = await manager.fetch("smoke-static", { method: "GET", path: "/about", headers: {} });
  if (spaFallback.status !== 200 || !spaFallback.body.toString("utf8").includes("STATIC_SMOKE_OK")) {
    throw new Error(`Static SPA fallback failed: ${spaFallback.status}`);
  }
  const traversal = await manager.fetch("smoke-static", {
    method: "GET",
    path: "/../deployments.json",
    headers: {}
  });
  if (traversal.status !== 404) {
    throw new Error(`Static traversal was not rejected: ${traversal.status}`);
  }
  const postBlocked = await manager.fetch("smoke-static", { method: "POST", path: "/", headers: {} });
  if (postBlocked.status !== 405) {
    throw new Error(`Static POST was not rejected: ${postBlocked.status}`);
  }

  // Static redeploy replaces the served files.
  writeFileSync(join(sitePath, "index.html"), "<h1>STATIC_SMOKE_V2</h1>", "utf8");
  const oldStaticDir = staticDeployment.staticDir;
  const staticV2 = await manager.publish({ path: "site", slug: "smoke-static" });
  const staticV2Page = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  if (!staticV2Page.body.toString("utf8").includes("STATIC_SMOKE_V2")) {
    throw new Error("Static redeploy did not serve updated content");
  }
  if (!staticV2.staticDir || staticV2.staticDir === oldStaticDir) {
    throw new Error("Static redeploy did not version the served directory");
  }

  // --- Quota ---
  let quotaBlocked = false;
  try {
    await manager.publish({ path: "site", slug: "smoke-third" });
  } catch (error) {
    quotaBlocked = String(error).includes("Deployment limit reached");
  }
  if (!quotaBlocked) {
    throw new Error("Third deployment was not blocked by the per-workspace quota");
  }

  // --- Resource caps on the running container ---
  const caps = await runPodman([
    "container",
    "inspect",
    "--format",
    "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.RestartPolicy.Name}}",
    redeployed.container
  ]);
  const [memBytes, pids, restartPolicy] = caps.output.trim().split(/\s+/);
  if (memBytes !== String(512 * 1024 * 1024) || pids !== "256" || restartPolicy !== "on-failure") {
    throw new Error(`Container caps missing: ${caps.output.trim()}`);
  }

  // --- Scale to zero: idle sweep suspends, next request wakes ---
  await manager.sweepIdle();
  const suspended = (await manager.list()).find((entry) => entry.slug === redeployed.slug);
  if (suspended?.status !== "suspended") {
    throw new Error(`Idle sweep did not suspend: ${JSON.stringify(suspended)}`);
  }
  const containerState = await runPodman(["container", "inspect", "--format", "{{.State.Running}}", redeployed.container]);
  if (containerState.output.trim() !== "false") {
    throw new Error("Suspended container is still running");
  }
  const wokenPage = await manager.fetch(redeployed.slug, { method: "GET", path: "/", headers: {} });
  if (wokenPage.status !== 200 || !wokenPage.body.toString("utf8").includes("DEPLOY_SMOKE_OK_V2")) {
    throw new Error(`Suspended deployment did not wake on request: ${wokenPage.status}`);
  }
  const awake = (await manager.list()).find((entry) => entry.slug === redeployed.slug);
  if (awake?.status !== "running") {
    throw new Error(`Woken deployment is not running: ${JSON.stringify(awake)}`);
  }

  // --- Reboot recovery: an externally stopped container is treated as suspended and wakes ---
  await runPodman(["stop", "-t", "1", redeployed.container]);
  const rebootPage = await manager.fetch(redeployed.slug, { method: "GET", path: "/", headers: {} });
  if (rebootPage.status !== 200 || !rebootPage.body.toString("utf8").includes("DEPLOY_SMOKE_OK_V2")) {
    throw new Error(`Stopped container did not wake on request: ${rebootPage.status}`);
  }

  await manager.remove("smoke-static");
  const staticGone = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  if (staticGone.status !== 404) {
    throw new Error(`Removed static deployment still routes: ${staticGone.status}`);
  }

  await runPodman(["rm", "-f", redeployed.container]);
  const stoppedResponse = await manager.fetch(redeployed.slug, {
    method: "GET",
    path: "/",
    headers: {}
  });
  if (stoppedResponse.status !== 503 || !stoppedResponse.body.toString("utf8").includes("stopped")) {
    throw new Error(`Stopped deployment did not reconcile on fetch: ${stoppedResponse.status}`);
  }
  const stopped = (await manager.list()).find((entry) => entry.slug === redeployed.slug);
  if (stopped?.status !== "stopped") {
    throw new Error(`Stopped deployment did not reconcile on list: ${JSON.stringify(stopped)}`);
  }

  await manager.remove(redeployed.slug);
  deployedSlug = undefined;
  await expectMissing(["container", "exists", redeployed.container], "removed deployment container still exists");
  await expectMissing(["image", "exists", redeployed.image], "removed deployment image still exists");

  console.log(`deploy smoke ok: ${deployment.urlPath}`);
} finally {
  if (deployedSlug) {
    await manager.remove(deployedSlug);
  }
  rmSync(workspace, { recursive: true, force: true });
}

function writeApp(marker: string): void {
  writeFileSync(
    join(projectPath, "server.mjs"),
    `import http from "node:http";

const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/final" });
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<a href="/asset.css">asset</a><span>${marker}</span>');
}).listen(port, "0.0.0.0", () => {
  console.log("smoke app listening on " + port);
});
`,
    "utf8"
  );
}

function writeValidDockerfile(): void {
  writeFileSync(
    join(projectPath, "Dockerfile"),
    `FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY server.mjs .
ENV PORT=3000
CMD ["node", "server.mjs"]
`,
    "utf8"
  );
}

function writeBrokenDockerfile(): void {
  writeFileSync(
    join(projectPath, "Dockerfile"),
    `FROM docker.io/library/node:24-alpine
THIS_IS_NOT_VALID_DOCKERFILE_SYNTAX
`,
    "utf8"
  );
}

function writeWrongPortDockerfile(): void {
  writeFileSync(
    join(projectPath, "Dockerfile"),
    `FROM docker.io/library/node:24-alpine
CMD ["node", "-e", "require('node:http').createServer((req,res)=>res.end('wrong-port')).listen(3011,'0.0.0.0')"]
`,
    "utf8"
  );
}

async function waitForPage(fetchPage: () => Promise<{ status: number; body: Buffer }>, marker = "DEPLOY_SMOKE_OK") {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const page = await fetchPage();
    last = page.body.toString("utf8");
    if (page.status === 200 && last.includes(marker)) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Deployment never became ready: ${last.slice(0, 300)}`);
}

async function expectMissing(args: string[], message: string): Promise<void> {
  const result = await runPodman(args);
  if (result.exitCode === 0) {
    throw new Error(message);
  }
}

function runPodman(args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.AGENTMOM_PODMAN_COMMAND ?? "podman", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => chunks.push(data));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
