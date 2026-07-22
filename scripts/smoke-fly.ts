/**
 * Integration smoke for the Fly sandbox runtime: provisions a real machine
 * for a scratch workspace, exercises exec/file/spawn/proxy/tar, then deletes
 * the app. Needs AGENTMOM_FLY_API_TOKEN (or fly CLI auth) and network.
 *
 * Usage: AGENTMOM_FLY_API_TOKEN=$(fly auth token) npm run smoke:fly
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agentmom-fly-"));
process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "fly";
process.env.AGENTMOM_FLY_SHIM_URL ??= "https://agentmom.xyz/api/sandbox-shim";
process.env.AGENTMOM_FLY_APP_PREFIX ??= "am-smoke-";

const { loadConfig } = await import("../src/config.js");
const { FlySandbox } = await import("../src/fly-machines.js");

const config = { ...loadConfig(), workspaceId: `smoke${Date.now().toString(36)}` };
assert.ok(config.fly.token, "AGENTMOM_FLY_API_TOKEN is required");
const sandbox = new FlySandbox(config);
console.log(`app: ${sandbox.appName}`);

try {
  let t = Date.now();
  await sandbox.ensureStarted();
  console.log(`provisioned + started in ${Date.now() - t}ms`);

  // exec with streaming
  const chunks: Buffer[] = [];
  t = Date.now();
  const result = await sandbox.createBashExec()("echo hello-from-$(hostname) && node --version", config.agentCwd, {
    onData: (data) => chunks.push(data)
  });
  const output = Buffer.concat(chunks).toString("utf8");
  assert.equal(result.exitCode, 0);
  assert.match(output, /hello-from-/);
  assert.match(output, /v24/);
  console.log(`exec ok (${Date.now() - t}ms): ${output.trim().split("\n")[0]}`);

  // HOME is the workspace (skills-convention safety)
  const homeChunks: Buffer[] = [];
  await sandbox.createBashExec()("echo HOME=$HOME && mkdir -p ~/.pi/skills && touch ~/.pi/skills/probe", config.agentCwd, {
    onData: (data) => homeChunks.push(data)
  });
  assert.match(Buffer.concat(homeChunks).toString("utf8"), /HOME=\/workspace/);
  await sandbox.access("/workspace/.pi/skills/probe");
  console.log("HOME=/workspace and ~/.pi lands on the volume");

  // file ops incl host->guest mapping
  await sandbox.writeFile("/workspace/demo/hello.txt", "fly-file-ok");
  const read = await sandbox.readFile(`${config.projectsDir}/demo/hello.txt` && "/workspace/demo/hello.txt");
  assert.equal(read.toString("utf8"), "fly-file-ok");
  const mapped = sandbox.hostToGuest(join(config.projectsDir, "demo", "hello.txt"));
  assert.equal(mapped, "/workspace/demo/hello.txt");
  console.log("file ops + path mapping ok");

  // spawn + proxy (dev-server shape)
  await sandbox.spawnDetached("cd /workspace/demo && python3 -m http.server 8055", "/workspace/demo");
  let proxied: { status: number; body: Buffer } | undefined;
  for (let i = 0; i < 20; i += 1) {
    const response = await sandbox.proxy(8055, { method: "GET", path: "/hello.txt", headers: {} });
    if (response.status === 200) {
      proxied = response;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(proxied, "proxy to spawned server never succeeded");
  assert.equal(proxied.body.toString("utf8"), "fly-file-ok");
  console.log("spawn + proxy ok");

  // push/pull mirror roundtrip
  const pushSrc = join(root, "push");
  mkdirSync(join(pushSrc, "sub"), { recursive: true });
  writeFileSync(join(pushSrc, "sub", "data.txt"), "push-pull-ok");
  await sandbox.pushDir(pushSrc, "/workspace/pushed");
  const pullDest = join(root, "pull");
  await sandbox.pullDir("/workspace/pushed", pullDest);
  assert.equal(readFileSync(join(pullDest, "sub", "data.txt"), "utf8"), "push-pull-ok");
  console.log("push/pull ok");

  // incremental pull only carries fresh files
  await new Promise((r) => setTimeout(r, 1500));
  const sinceMs = Date.now() - 500;
  await sandbox.createBashExec()("touch /workspace/pushed/fresh.txt", config.agentCwd, { onData: () => {} });
  const incDest = join(root, "inc");
  await sandbox.pullDir("/workspace/pushed", incDest, sinceMs);
  assert.ok(existsSync(join(incDest, "fresh.txt")), "incremental pull missed fresh file");
  assert.ok(!existsSync(join(incDest, "sub", "data.txt")), "incremental pull included stale file");
  console.log("incremental pull ok");

  // stop -> wake
  await sandbox.stop();
  t = Date.now();
  const wakeChunks: Buffer[] = [];
  const woken = await sandbox.createBashExec()("cat /workspace/demo/hello.txt", config.agentCwd, {
    onData: (data) => wakeChunks.push(data)
  });
  assert.equal(woken.exitCode, 0);
  assert.equal(Buffer.concat(wakeChunks).toString("utf8").trim(), "fly-file-ok");
  console.log(`stop -> wake -> exec with volume intact in ${Date.now() - t}ms`);

  console.log("fly smoke ok");
} finally {
  // Delete the scratch app entirely (machines + volume go with it).
  await fetch(`https://api.machines.dev/v1/apps/${sandbox.appName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.fly.token}` }
  }).catch(() => {});
  rmSync(root, { recursive: true, force: true });
  console.log(`cleaned up app ${sandbox.appName}`);
}
