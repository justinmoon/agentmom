import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { TutorialVibeManager } from "../src/tutorial-vibe.js";
import { FlySandbox } from "../src/fly-machines.js";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string; body?: any }> = [];
const temp = mkdtempSync(join(tmpdir(), "agentmom-vibe-sandbox-"));

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  requests.push({ url, method, body });
  if (url === "https://api.machines.dev/v1/apps?org_slug=personal") {
    return Response.json({ apps: [] });
  }
  if (url === "https://api.machines.dev/v1/apps" && method === "POST") return Response.json({});
  if (url === "https://api.fly.io/graphql") return Response.json({ data: {} });
  if (/\/volumes$/.test(url) && method === "GET") return Response.json([{ id: "volume-1", name: "workspace" }]);
  if (/\/machines$/.test(url) && method === "GET") return Response.json([]);
  if (/\/machines$/.test(url) && method === "POST") return Response.json({ id: "machine-1" });
  if (url.endsWith(".fly.dev/health")) return Response.json({ ok: true });
  if (url.endsWith(".fly.dev/exec") && method === "POST") {
    return new Response(`${JSON.stringify({ x: 0 })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (url.includes("/apps/am-demo-") && method === "DELETE") return new Response(null, { status: 200 });
  throw new Error(`unexpected fetch: ${method} ${url}`);
};

try {
  process.env.TECHNICALLY_SPEAKING_VIBE_MAX_ACTIVE_SANDBOXES = "1";
  const config = loadConfig();
  config.stateDir = temp;
  config.fly.token = "test-fly-token";
  config.fly.shimUrl = "https://agentmom.test/api/sandbox-shim";
  config.fly.demoIdleMinutes = 0;
  config.fly.demoMaxMinutes = 20;
  config.fly.demoMemoryMb = 512;
  const manager = new TutorialVibeManager(config);
  const run = await manager.begin("user-1");
  await run.sandbox.ensureStarted();
  run.release();
  await assert.rejects(() => manager.begin("user-2"), /sandboxes are busy/);

  const create = requests.find((request) => /\/machines$/.test(request.url) && request.method === "POST");
  assert(create);
  assert.equal(create.body.config.auto_destroy, true);
  assert.equal(create.body.config.mounts, undefined, "tutorial machine must not create or mount a volume");
  assert.equal(create.body.config.guest.memory_mb, 512);
  assert.equal(create.body.config.env.AGENTMOM_IDLE_MS, "0");
  assert.equal(create.body.config.env.AGENTMOM_ALLOW_SPAWN, "0");
  assert.equal(create.body.config.env.AGENTMOM_STRICT_FILE_JAIL, "1");
  assert.equal(create.body.config.env.AGENTMOM_KILL_PROCESS_GROUP, "1");
  assert.equal(create.body.config.env.OPENROUTER_API_KEY, undefined);

  await manager.sweepNow();
  assert(requests.some((request) => request.method === "DELETE" && request.url.includes("/apps/am-demo-")));
  await manager.dispose();

  config.workspaceId = "normal-workspace";
  const normalSandbox = new FlySandbox(config);
  await normalSandbox.createBashExec()("pwd", join(config.projectsDir, "nested"), { onData: () => {} });
  const normalExec = [...requests].reverse().find((request) => request.url.endsWith(".fly.dev/exec"));
  assert.equal(normalExec?.body.cwd, "/workspace/nested", "normal Fly Bash must preserve the requested guest cwd");
  console.log("tutorial sandbox smoke ok");
} finally {
  delete process.env.TECHNICALLY_SPEAKING_VIBE_MAX_ACTIVE_SANDBOXES;
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
}
