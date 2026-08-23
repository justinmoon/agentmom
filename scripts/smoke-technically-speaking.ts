import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agentmom-technically-speaking-"));
const receivedRequests: Array<Record<string, any>> = [];
const searchRequests: string[] = [];
const sandboxCommands: string[] = [];
const sandboxFiles = new Map<string, Buffer>();

const sandbox = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, root: "/workspace" }));
    return;
  }
  if (url.pathname === "/reset" && req.method === "POST") {
    sandboxFiles.clear();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/file" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/files") {
    const files = [...sandboxFiles.entries()].map(([path, data]) => ({ path, size: data.byteLength }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files }));
    return;
  }
  if (url.pathname === "/file" && req.method === "GET") {
    const path = url.searchParams.get("path")?.replace("/workspace/site/", "") ?? "";
    const data = sandboxFiles.get(path);
    if (!data) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(data);
    return;
  }
  if (url.pathname === "/exec" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    sandboxCommands.push(body.command);
    if (sandboxCommands.length === 1) {
      sandboxFiles.set("index.html", Buffer.from('<!doctype html><link rel="stylesheet" href="styles.css"><h1>Staten Island</h1>'));
    } else {
      sandboxFiles.set("styles.css", Buffer.from("body { font-family: sans-serif; }"));
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.end(`${JSON.stringify({ o: Buffer.from("wrote files\n").toString("base64") })}\n${JSON.stringify({ x: 0 })}\n`);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => sandbox.listen(0, "127.0.0.1", resolve));
const sandboxAddress = sandbox.address();
assert(sandboxAddress && typeof sandboxAddress === "object");

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
    const offeredTool = request.tools?.[0]?.function?.name;
    const bashResults = request.messages.filter((message: Record<string, unknown>) => message.role === "tool" && message.name === "bash");
    const message = emptyResponse
      ? { role: "assistant", content: "" }
      : offeredTool === "bash" && bashResults.length < 2
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `bash-${bashResults.length + 1}`,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: bashResults.length === 0
                      ? "cat > index.html <<'EOF'\n<h1>Staten Island</h1>\nEOF"
                      : "printf '%s' 'body { font-family: sans-serif; }' > styles.css"
                  })
                }
              }
            ]
          }
      : offeredTool === "bash" || bashResults.length > 0
        ? { role: "assistant", content: "Built the Staten Island page and checked its files." }
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
    AGENTMOM_TUTORIAL_SANDBOX_URL: `http://127.0.0.1:${sandboxAddress.port}`,
    AGENTMOM_TUTORIAL_SANDBOX_TOKEN: "smoke-sandbox-token",
    BRAVE_API_KEY: "smoke-brave-key",
    BRAVE_LLM_CONTEXT_URL: `http://127.0.0.1:${upstreamAddress.port}/search`,
    OPENROUTER_API_KEY: "smoke-openrouter-key",
    OPENROUTER_CHAT_URL: `http://127.0.0.1:${upstreamAddress.port}`
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

  const anonymousPage = await fetch(`${baseUrl}/technically-speaking/`, { redirect: "manual" });
  assert.equal(anonymousPage.status, 302);
  assert.equal(anonymousPage.headers.get("location"), "/");

  const anonymousChat = await fetch(`${baseUrl}/technically-speaking/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt: "", messages: [] })
  });
  assert.equal(anonymousChat.status, 401);
  assert.equal(receivedRequests.length, 0, "anonymous request reached OpenRouter");

  const anonymousToolDemo = await fetch(`${baseUrl}/technically-speaking/api/tool-demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "What changed?", searchEnabled: true })
  });
  assert.equal(anonymousToolDemo.status, 401);
  assert.equal(receivedRequests.length, 0, "anonymous tool demo reached OpenRouter");
  assert.equal(searchRequests.length, 0, "anonymous tool demo reached Brave");

  const anonymousVibeDemo = await fetch(`${baseUrl}/technically-speaking/api/vibe-demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Make a page" })
  });
  assert.equal(anonymousVibeDemo.status, 401);
  assert.equal(sandboxCommands.length, 0, "anonymous website demo reached the sandbox");

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@example.com", password: "password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);
  const headers = { Cookie: cookie };

  const redirect = await fetch(`${baseUrl}/technically-speaking`, { headers, redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/technically-speaking/");

  const page = await fetch(`${baseUrl}/technically-speaking/`, { headers });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /How a chat agent works/);
  assert.match(pageHtml, /9\. Tool calls/);
  assert.match(pageHtml, /Who actually searches the web/);
  assert.match(pageHtml, /tool-results-dialog/);
  assert.match(pageHtml, /tool-wire-dialog/);
  assert.match(pageHtml, /Give the agent Bash/);
  assert.match(pageHtml, /vibe-preview-frame/);

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

  const vibe = await fetch(`${baseUrl}/technically-speaking/api/vibe-demo`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Make a one-page website about Staten Island." })
  });
  assert.equal(vibe.status, 200);
  assert.equal(vibe.headers.get("x-tutorial-vibe-api-version"), "1");
  const vibeEvents = (await vibe.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(vibeEvents[0].type, "user_message");
  assert.equal(vibeEvents.at(-1).type, "done");
  assert.equal(vibeEvents.filter((event) => event.type === "model_tool_call").length, 2);
  assert.equal(vibeEvents.filter((event) => event.type === "agent_tool_result").length, 2);
  assert.match(vibeEvents.find((event) => event.type === "model_tool_call").arguments.command, /index\.html/);
  assert.equal(sandboxCommands.length, 2);
  const vibeRequests = receivedRequests.filter((request) => request.tools?.[0]?.function?.name === "bash");
  assert.equal(vibeRequests[0].tool_choice, "required");
  assert.equal(vibeRequests[0].parallel_tool_calls, false);
  assert.equal(vibeRequests[1].tool_choice, "auto");

  const files = await fetch(`${baseUrl}/technically-speaking/api/vibe-files`, { headers });
  assert.equal(files.status, 200);
  assert.deepEqual((await files.json()).files.map((file: { path: string }) => file.path).sort(), ["index.html", "styles.css"]);

  const file = await fetch(`${baseUrl}/technically-speaking/api/vibe-file?path=index.html`, { headers });
  assert.equal(file.status, 200);
  assert.match(await file.text(), /Staten Island/);

  const preview = await fetch(`${baseUrl}/technically-speaking/api/vibe-preview/index.html`, { headers });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
  assert.match(await preview.text(), /Staten Island/);

  const traversal = await fetch(`${baseUrl}/technically-speaking/api/vibe-file?path=../secret`, { headers });
  assert.equal(traversal.status, 400);

  const resetVibe = await fetch(`${baseUrl}/technically-speaking/api/vibe-demo`, { method: "DELETE", headers });
  assert.equal(resetVibe.status, 200);
  assert.equal(sandboxFiles.size, 0);

  console.log("technically-speaking smoke ok");
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => sandbox.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
