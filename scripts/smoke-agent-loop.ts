import assert from "node:assert/strict";
import type { UiEvent } from "../src/types.js";
import { buildAgentLoop, requestSummary, resultSummary } from "../web/agent-loop.js";

const at = "2026-08-23T18:00:00.000Z";
const events: UiEvent[] = [
  event("tool", "read finished", JSON.stringify({ content: [{ type: "text", text: "hello" }] }), "call-read"),
  event("tool", "read update", JSON.stringify({ content: "partial" }), "call-read"),
  event("tool", "read started", JSON.stringify({ path: "index.html" }), "call-read"),
  event("model", "Model requested read", JSON.stringify({ id: "call-read", name: "read", arguments: { path: "index.html" } }), "call-read"),
  event("runtime", "Fly sandbox", "am-noise"),
  event("session", "Started new session", "/tmp/noise")
];

const loop = buildAgentLoop(events);
assert.equal(loop.length, 1);
assert.equal(loop[0].id, "call-read");
assert.equal(loop[0].toolName, "read");
assert.match(requestSummary(loop[0]), /index\.html/);
assert.equal(resultSummary(loop[0]), "hello");
assert.ok(loop[0].startedAt);
assert.ok(loop[0].finishedAt);

console.log("agent loop smoke ok");

function event(type: string, title: string, detail?: string, toolCallId?: string): UiEvent {
  return { id: `${type}-${title}`, type, title, detail, toolCallId, createdAt: at };
}
