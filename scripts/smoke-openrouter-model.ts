import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import {
  confirmFreeOxAlpha,
  createOxAlphaModel,
  OX_ALPHA_MODEL
} from "../src/openrouter-model.js";

const listing = {
  id: OX_ALPHA_MODEL,
  name: "Ox Alpha",
  pricing: { prompt: "0", completion: "0.000" },
  context_length: 1_048_576,
  architecture: { input_modalities: ["text", "image", "video"] },
  top_provider: { max_completion_tokens: 131_072 }
};

const free = await confirmFreeOxAlpha(jsonFetcher({ data: [listing] }));
assert.deepEqual(free, {
  id: OX_ALPHA_MODEL,
  name: "Ox Alpha",
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text", "image"]
});

assert.equal(
  await confirmFreeOxAlpha(
    jsonFetcher({ data: [{ ...listing, pricing: { prompt: "0.000001", completion: "0" } }] })
  ),
  undefined
);
assert.equal(
  await confirmFreeOxAlpha(
    jsonFetcher({ data: [{ ...listing, pricing: { prompt: "0", completion: "0.000001" } }] })
  ),
  undefined
);
assert.equal(await confirmFreeOxAlpha(jsonFetcher({ data: [] })), undefined);
assert.equal(await confirmFreeOxAlpha(async () => Promise.reject(new Error("offline"))), undefined);

const template: Model<any> = {
  id: "fallback",
  name: "Fallback",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 1,
  maxTokens: 1
};
const model = createOxAlphaModel(template, free!);
assert.equal(model.id, OX_ALPHA_MODEL);
assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.equal(model.provider, "openrouter");
assert.equal(model.contextWindow, 1_048_576);

console.log("OpenRouter free-model gate smoke ok");

function jsonFetcher(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
}
