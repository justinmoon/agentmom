import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PiBridge } from "../src/pi-bridge.js";
import { PreviewManager } from "../src/previews.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-session-switch-"));

process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

const config = loadConfig();
let bridge: PiBridge | undefined;

try {
  bridge = new PiBridge(config, new PreviewManager(config));
  await bridge.init();

  const withOldEvent = bridge.registerPreview(12345, "Old preview");
  assert.equal(
    withOldEvent.events.some((event) => event.title === "Preview exposed"),
    true
  );

  const fresh = await bridge.openSession({ kind: "new" });
  assert.notEqual(fresh.session?.path, withOldEvent.session?.path);
  assert.deepEqual(
    fresh.events.map((event) => event.title),
    ["Started new session"]
  );
  assert.equal(fresh.messages.length, 0);

  const runningFlag = bridge as unknown as { isRunning: boolean };
  runningFlag.isRunning = true;
  const busySession = (await bridge.snapshot()).session?.path;
  await assert.rejects(
    () => bridge!.openSession({ kind: "new" }),
    (error) => {
      assert.equal((error as { status?: unknown }).status, 409);
      assert.match(error instanceof Error ? error.message : String(error), /finish or stop/i);
      return true;
    }
  );
  assert.equal((await bridge.snapshot()).session?.path, busySession);

  console.log("session switch smoke ok");
} finally {
  bridge?.dispose();
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
