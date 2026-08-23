import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agentmom-technically-speaking-"));
const receivedRequests: Array<Record<string, any>> = [];
const searchRequests: string[] = [];

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/search") {
    searchRequests.push(url.searchParams.get("q") ?? "");
    const sourceUrl = "https://www.fifa.com/en/articles/final-tournament-standings";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        grounding: {
          generic: [
            {
              url: sourceUrl,
              title: "World Cup 2026: Final tournament standings",
              snippets: ["Spain won the 2026 FIFA World Cup after beating Argentina 1-0 after extra time in the final."]
            }
          ]
        },
        sources: {
          [sourceUrl]: {
            title: "World Cup 2026: Final tournament standings",
            hostname: "fifa.com"
          }
        }
      })
    );
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  receivedRequests.push(request);

  if (request.stream === false) {
    const userMessage = request.messages.find((message: Record<string, unknown>) => message.role === "user");
    const emptyResponse = typeof userMessage?.content === "string" && userMessage.content.includes("EMPTY_RESPONSE_TEST");
    const toolMessage = request.messages.find((message: Record<string, unknown>) => message.role === "tool");
    const message = emptyResponse
      ? { role: "assistant", content: "" }
      : request.tools
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "search-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "2026 FIFA World Cup winner final result" })
              }
            }
          ]
        }
      : toolMessage
        ? {
            role: "assistant",
            content: "Spain won the 2026 FIFA World Cup, beating Argentina 1-0 after extra time in the final. Source: https://www.fifa.com/en/articles/final-tournament-standings"
          }
        : {
            role: "assistant",
            content: "I cannot verify this post-cutoff fact without current information."
          };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: request.model,
        choices: [{ message, finish_reason: emptyResponse ? "length" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      })
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (request.reasoning?.exclude === false) {
    res.write(
      `data: ${JSON.stringify({ model: request.model, choices: [{ delta: { reasoning: "Checked the constraints. " } }] })}\n\n`
    );
  }
  res.write(`data: ${JSON.stringify({ model: request.model, choices: [{ delta: { content: "Hello" } }] })}\n\n`);
  res.write(
    'data: {"choices":[{"delta":{"content":" there"}}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\n\n'
  );
  res.end("data: [DONE]\n\n");
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress === "object");

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const probeAddress = probe.address();
assert(probeAddress && typeof probeAddress === "object");
const port = probeAddress.port;
await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    AGENTMOM_AUTH_ENABLED: "1",
    AGENTMOM_DEV_AUTH_PASSWORD: "password",
    AGENTMOM_DEV_AUTH_USERS: "user@example.com|Demo User|user",
    AGENTMOM_PORT: String(port),
    AGENTMOM_STATE_DIR: join(root, "state"),
    AGENTMOM_WORKSPACE: join(root, "workspace"),
    AGENTMOM_WORKSPACE_ROOT: join(root, "workspaces"),
    AGENTMOM_PROJECTS_DIR: join(root, "projects"),
    AGENTMOM_TELEGRAM_BOT_TOKEN: "smoke-telegram-token",
    AGENTMOM_TELEGRAM_DISABLED: "1",
    BRAVE_API_KEY: "smoke-brave-key",
    BRAVE_LLM_CONTEXT_URL: `http://127.0.0.1:${upstreamAddress.port}/search`,
    OPENROUTER_API_KEY: "smoke-openrouter-key",
    OPENROUTER_CHAT_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    AGENTMOM_OPENROUTER_MODEL: "openai/gpt-5.6-luna"
  },
  stdio: "ignore"
});

const baseUrl = `http://127.0.0.1:${port}`;

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, "Agent Mom did not start");

  const headers = {};

  const redirect = await fetch(`${baseUrl}/technically-speaking`, { headers, redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/technically-speaking/");

  const page = await fetch(`${baseUrl}/technically-speaking/`, { headers });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /The Agent Escape Room/);
  assert.match(pageHtml, /<span>6 rooms<\/span>/);
  assert.match(pageHtml, /Room 06/);
  assert.match(pageHtml, /Web Search/);
  assert.match(pageHtml, /Who actually searches the web/);
  assert.match(pageHtml, /tool-results-dialog/);
  assert.match(pageHtml, /tool-wire-dialog/);
  assert.doesNotMatch(pageHtml, /One more tool makes this coding/);
  const roomViews = [...pageHtml.matchAll(/class="prototype-tab(?: active)?" data-view="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(roomViews, ["wire", "system", "compare", "tokens", "thinking", "tools"]);
  const ids = [...pageHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "tutorial HTML contains duplicate IDs");

  const appSourceResponse = await fetch(`${baseUrl}/technically-speaking/app.js`, { headers });
  assert.equal(appSourceResponse.status, 200);
  const appSource = await appSourceResponse.text();
  assert.match(appSource, /toolsWorkspaceEl\.hidden = !tools/);
  assert.match(appSource, /if \(tools\) renderToolDemo\(\)/);
  assert.match(appSource, /showRoomFiveIntro\(\)/);
  assert.match(appSource, /MAX_ANIMATED_INBOUND_TOKENS = 12/);

  const config = await fetch(`${baseUrl}/technically-speaking/api/config`, { headers });
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    model: "openai/gpt-5.6-luna",
    pricing: { inputPerMillion: 0.2, outputPerMillion: 1.2 }
  });

  const chat = await fetch(`${baseUrl}/technically-speaking/api/chat`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemPrompt: "Answer like a pirate.",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
    })
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get("x-tutorial-api-version"), "4");
  const events = (await chat.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.filter((event) => event.type === "delta").map((event) => event.text),
    ["Hello", " there"]
  );
  assert.equal(events.find((event) => event.type === "usage").usage.total_tokens, 14);
  assert.equal(receivedRequests[0].model, "openai/gpt-5.6-luna");
  assert.deepEqual(receivedRequests[0].reasoning, { effort: "none", exclude: true });

  const comparison = await fetch(`${baseUrl}/technically-speaking/api/chat`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/llama-3.2-1b-instruct",
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
    })
  });
  assert.equal(comparison.status, 200);
  await comparison.text();
  assert.equal(receivedRequests[1].model, "meta-llama/llama-3.2-1b-instruct");
  assert.equal(receivedRequests[1].reasoning, undefined);

  const thinking = await fetch(`${baseUrl}/technically-speaking/api/chat`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      reasoningEffort: "high",
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "Solve this" }] }]
    })
  });
  assert.equal(thinking.status, 200);
  const thinkingEvents = (await thinking.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(receivedRequests[2].reasoning, { effort: "high", exclude: false });
  assert.equal(receivedRequests[2].max_completion_tokens, 4096);
  assert.equal(thinkingEvents.find((event) => event.type === "reasoning").text, "Checked the constraints. ");

  const rejected = await fetch(`${baseUrl}/technically-speaking/api/chat`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "unapproved/model", systemPrompt: "", messages: [] })
  });
  assert.equal(rejected.status, 400);

  const question = "Who won the 2026 FIFA World Cup, and whom did they beat in the final?";
  const withoutSearch = await fetch(`${baseUrl}/technically-speaking/api/tool-demo`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ question, searchEnabled: false })
  });
  assert.equal(withoutSearch.status, 200);
  assert.equal(withoutSearch.headers.get("x-tutorial-tool-api-version"), "1");
  const withoutSearchEvents = (await withoutSearch.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    withoutSearchEvents.map((event) => event.type),
    ["user_message", "agent_model_request", "model_response", "agent_user_response", "done"]
  );
  assert.equal(receivedRequests[3].model, "openai/gpt-oss-20b");
  assert.equal(receivedRequests[3].tools, undefined);
  assert.equal(receivedRequests[3].max_completion_tokens, 1024);
  assert.deepEqual(receivedRequests[3].reasoning, { effort: "minimal", exclude: true });
  assert.deepEqual(withoutSearchEvents.find((event) => event.type === "agent_model_request").request, receivedRequests[3]);
  assert.deepEqual(
    withoutSearchEvents.find((event) => event.type === "model_response").response.choices[0].message,
    { role: "assistant", content: "I cannot verify this post-cutoff fact without current information." }
  );
  assert.equal(searchRequests.length, 0);
  assert.match(withoutSearchEvents.find((event) => event.type === "agent_user_response").text, /cannot verify/);

  const withSearch = await fetch(`${baseUrl}/technically-speaking/api/tool-demo`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ question, searchEnabled: true })
  });
  assert.equal(withSearch.status, 200);
  const withSearchEvents = (await withSearch.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    withSearchEvents.map((event) => event.type),
    [
      "user_message",
      "agent_model_request",
      "model_tool_call",
      "agent_tool_start",
      "agent_tool_result",
      "agent_model_request",
      "model_response",
      "agent_user_response",
      "done"
    ]
  );
  assert.equal(receivedRequests[4].tools[0].function.name, "web_search");
  assert.equal(receivedRequests[4].tool_choice, "required");
  assert.equal(receivedRequests[4].parallel_tool_calls, false);
  assert.deepEqual(withSearchEvents.find((event) => event.type === "agent_model_request").request, receivedRequests[4]);
  assert.equal(
    withSearchEvents.find((event) => event.type === "model_tool_call").response.choices[0].message.tool_calls[0]
      .function.name,
    "web_search"
  );
  assert.equal(receivedRequests[5].tools, undefined);
  assert.equal(receivedRequests[5].messages.some((message: Record<string, unknown>) => message.role === "tool"), true);
  assert.deepEqual(
    withSearchEvents.filter((event) => event.type === "agent_model_request")[1].request,
    receivedRequests[5]
  );
  assert.equal(searchRequests.length, 1);
  assert.match(searchRequests[0], /World Cup/);
  const toolResult = withSearchEvents.find((event) => event.type === "agent_tool_result");
  assert.equal(toolResult.sources.length, 1);
  assert.match(toolResult.sources[0].snippets[0], /Spain/);
  assert.match(withSearchEvents.find((event) => event.type === "agent_user_response").text, /Argentina/);
  assert.deepEqual(withSearchEvents.at(-1), {
    at: withSearchEvents.at(-1).at,
    type: "done",
    searchEnabled: true,
    modelCalls: 2,
    toolCalls: 1
  });

  const emptyResponse = await fetch(`${baseUrl}/technically-speaking/api/tool-demo`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "EMPTY_RESPONSE_TEST", searchEnabled: false })
  });
  assert.equal(emptyResponse.status, 200);
  const emptyEvents = (await emptyResponse.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    emptyEvents.map((event) => event.type),
    ["user_message", "agent_model_request", "model_no_answer", "agent_user_response", "done"]
  );
  assert.equal(emptyEvents.find((event) => event.type === "model_no_answer").finishReason, "length");
  assert.match(emptyEvents.find((event) => event.type === "agent_user_response").text, /Enable web_search/);

  console.log("technically-speaking smoke ok");
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
