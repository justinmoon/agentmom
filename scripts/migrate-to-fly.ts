/**
 * One-shot migration: provision a Fly sandbox for every catalog workspace and
 * push its existing host projectsDir into the machine's /workspace volume.
 * Idempotent — reruns re-push (tar overwrites, never deletes).
 *
 * Run on the server as the service user with its env:
 *   AGENTMOM_FLY_API_TOKEN_FILE=... AGENTMOM_EXECUTOR=fly tsx scripts/migrate-to-fly.ts
 */

import { existsSync, readdirSync } from "node:fs";

const CONCURRENCY = 4;

const { loadConfig } = await import("../src/config.js");
const { CatalogStore } = await import("../src/catalog.js");
const { workspaceConfig } = await import("../src/workspace-runtime.js");
const { FlySandbox } = await import("../src/fly-machines.js");

const base = loadConfig();
if (!base.fly.token) {
  console.error("fly token missing (AGENTMOM_FLY_API_TOKEN or _FILE)");
  process.exit(1);
}
const catalog = new CatalogStore(base);
const workspaces = catalog.read().workspaces;
console.log(`${workspaces.length} workspaces to migrate (region ${base.fly.region})`);

let failures = 0;
const queue = [...workspaces];

async function worker(): Promise<void> {
  for (;;) {
    const workspace = queue.shift();
    if (!workspace) return;
    const config = workspaceConfig(base, workspace);
    const sandbox = new FlySandbox(config);
    const started = Date.now();
    try {
      await sandbox.ensureStarted();
      const hasData = existsSync(config.projectsDir) && readdirSync(config.projectsDir).length > 0;
      if (hasData) {
        await sandbox.pushDir(config.projectsDir, "/workspace");
      }
      // Spot-check: a file listing from inside the machine.
      const chunks: Buffer[] = [];
      await sandbox.createBashExec()("ls -a /workspace | head -20", config.agentCwd, {
        onData: (data) => chunks.push(data)
      });
      const listing = Buffer.concat(chunks).toString("utf8").trim().split("\n").filter(Boolean);
      console.log(
        `ok ${workspace.slug} -> ${sandbox.appName} (${Date.now() - started}ms, ${hasData ? "data pushed" : "empty"}, ${listing.length} entries)`
      );
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${workspace.slug} (${sandbox.appName}): ${error instanceof Error ? error.message : error}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
if (failures > 0) {
  console.error(`${failures} workspace(s) failed`);
  process.exit(1);
}
console.log("migration push complete");
