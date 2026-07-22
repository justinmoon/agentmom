/**
 * Deployment smoke: static fast path, quota, slug/host routing. Container
 * deployments are Fly apps built remotely and are exercised by the live E2E
 * (they need a Fly token and minutes of build time — not smoke material).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "agentmom-deploy-"));
const agentCwd = join(workspace, "projects");

process.env.AGENTMOM_WORKSPACE = workspace;
process.env.AGENTMOM_AGENT_CWD = agentCwd;
process.env.AGENTMOM_DEPLOYMENT_DIR = join(workspace, ".agentmom", "deployments");
process.env.AGENTMOM_DEPLOYMENT_BASE_DOMAIN = "smoke.example.com";
process.env.AGENTMOM_DEPLOY_MAX_PER_WORKSPACE = "2";
delete process.env.AGENTMOM_FLY_API_TOKEN; // certificate calls must no-op

const { loadConfig } = await import("../src/config.js");
const { deploymentSlugFromHost, isAllowedDeploymentDomain } = await import("../src/deployment-routing.js");
const { DeploymentManager } = await import("../src/deployments.js");

const manager = new DeploymentManager(loadConfig());

try {
  // Routing helpers
  if (deploymentSlugFromHost("smoke-demo.smoke.example.com", "smoke.example.com") !== "smoke-demo") {
    throw new Error("Deployment host parser did not recognize slug host");
  }
  if (deploymentSlugFromHost("smoke.example.com", "smoke.example.com") !== undefined) {
    throw new Error("Deployment host parser should not route the base app host");
  }
  if (!isAllowedDeploymentDomain("smoke-demo.smoke.example.com", "smoke.example.com")) {
    throw new Error("TLS ask helper did not allow deployment host");
  }
  if (isAllowedDeploymentDomain("nested.smoke-demo.smoke.example.com", "smoke.example.com")) {
    throw new Error("TLS ask helper should not allow nested deployment hosts");
  }

  // Static deploy
  const sitePath = join(agentCwd, "site");
  mkdirSync(join(sitePath, "sub"), { recursive: true });
  writeFileSync(join(sitePath, "index.html"), '<link href="/style.css"><h1>STATIC_SMOKE_OK</h1>', "utf8");
  writeFileSync(join(sitePath, "style.css"), "h1 { color: red; }", "utf8");
  writeFileSync(join(sitePath, "sub", "index.html"), "<p>SUB_PAGE</p>", "utf8");

  const staticDeployment = await manager.publish({ path: "site", slug: "smoke-static" });
  if (staticDeployment.kind !== "static" || staticDeployment.status !== "running") {
    throw new Error(`Static deploy did not run as static: ${JSON.stringify(staticDeployment)}`);
  }
  if (staticDeployment.url !== "https://smoke-static.smoke.example.com/") {
    throw new Error(`Unexpected deployment URL: ${staticDeployment.url}`);
  }

  const page = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  const html = page.body.toString("utf8");
  if (page.status !== 200 || !html.includes("STATIC_SMOKE_OK")) {
    throw new Error(`Static page failed: ${page.status} ${html.slice(0, 200)}`);
  }
  if (!html.includes("/deploy/smoke-static/style.css")) {
    throw new Error(`Static proxy did not rewrite root asset paths: ${html.slice(0, 200)}`);
  }
  const hostPage = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} }, "host");
  if (!hostPage.body.toString("utf8").includes('href="/style.css"')) {
    throw new Error("Host-mode static response unexpectedly rewrote root paths");
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
  const traversal = await manager.fetch("smoke-static", { method: "GET", path: "/../deployments.json", headers: {} });
  if (traversal.status !== 404) {
    throw new Error(`Static traversal was not rejected: ${traversal.status}`);
  }
  const postBlocked = await manager.fetch("smoke-static", { method: "POST", path: "/", headers: {} });
  if (postBlocked.status !== 405) {
    throw new Error(`Static POST was not rejected: ${postBlocked.status}`);
  }

  // Versioned redeploy replaces the served files
  writeFileSync(join(sitePath, "index.html"), "<h1>STATIC_SMOKE_V2</h1>", "utf8");
  const oldStaticDir = staticDeployment.staticDir;
  const staticV2 = await manager.publish({ path: "site", slug: "smoke-static" });
  const v2Page = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  if (!v2Page.body.toString("utf8").includes("STATIC_SMOKE_V2")) {
    throw new Error("Static redeploy did not serve updated content");
  }
  if (!staticV2.staticDir || staticV2.staticDir === oldStaticDir) {
    throw new Error("Static redeploy did not version the served directory");
  }

  // Container path without a Fly token fails loudly, not silently
  const appPath = join(agentCwd, "app");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(join(appPath, "Dockerfile"), "FROM scratch\n", "utf8");
  let containerBlocked = false;
  try {
    await manager.publish({ path: "app", slug: "smoke-container", port: 3000 });
  } catch (error) {
    containerBlocked = String(error).includes("no Fly token");
  }
  if (!containerBlocked) {
    throw new Error("Container deploy without a Fly token did not fail cleanly");
  }

  // Quota
  const site2 = join(agentCwd, "site2");
  mkdirSync(site2, { recursive: true });
  writeFileSync(join(site2, "index.html"), "<h1>two</h1>", "utf8");
  await manager.publish({ path: "site2", slug: "smoke-second" });
  let quotaBlocked = false;
  try {
    await manager.publish({ path: "site2", slug: "smoke-third" });
  } catch (error) {
    quotaBlocked = String(error).includes("Deployment limit reached");
  }
  if (!quotaBlocked) {
    throw new Error("Third deployment was not blocked by the per-workspace quota");
  }

  // Removal
  await manager.remove("smoke-static");
  const gone = await manager.fetch("smoke-static", { method: "GET", path: "/", headers: {} });
  if (gone.status !== 404) {
    throw new Error(`Removed static deployment still routes: ${gone.status}`);
  }

  console.log("deploy smoke ok (static + quota + routing)");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
