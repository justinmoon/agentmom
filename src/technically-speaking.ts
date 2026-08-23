import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { TutorialVibeManager } from "./tutorial-vibe.js";
import { executeBraveWebSearch } from "./web-search.js";

const COMPARISON_MODELS = new Set([
  "meta-llama/llama-3.2-1b-instruct",
  "deepseek/deepseek-v3.2",
  "openai/gpt-5.6-luna"
]);
const TOOL_DEMO_MODEL = "openai/gpt-oss-20b";
const TOOL_DEMO_SYSTEM_PROMPT =
  'You are part of a teaching demo about agent tools. Your knowledge ends on June 30, 2024. Never guess facts from after that date. If web_search is available, request it before answering. After it returns, use only facts in its result, report any conflict, and include one supplied source URL. If web_search is unavailable and the question asks about a later event, answer exactly: "I do not know from my June 2024 snapshot. Enable web_search so the agent can check."';
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current, source-grounded information. The agent executes this tool.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused web search query"
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
} as const;
const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Run a Bash command inside the agent's temporary Fly.io website folder. Use it to inspect, create, edit, or download files. The agent executes the command; the model does not.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "A focused Bash command to run in /workspace/site"
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
} as const;
const VIBE_SYSTEM_PROMPT = [
  "You are part of a teaching demo about coding agents.",
  "Build the static webpage requested by the user in /workspace/site.",
  "You have one tool named bash. You request commands; the agent runs them in a temporary Fly.io sandbox and returns the result.",
  "Use bash to inspect the folder, write the files, and check your work. Create index.html. Put CSS and JavaScript in separate files when useful.",
  "You may use curl or wget when the user supplies an image URL. Do not start a web server, install packages, or write outside the current folder.",
  "Keep each command focused so a learner can follow the file reads and writes. Finish with a short summary after the page works."
].join(" ");
const VIBE_MAX_MODEL_CALLS = 6;
const VIBE_MAX_TOOL_CALLS = 5;

type MessagePart = { type: "text"; text: string };
type TutorialMessage = { role: "user" | "assistant"; content: MessagePart[] };
type ReasoningEffort = "none" | "low" | "high";

type TutorialChat = {
  model: string;
  comparison: boolean;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  messages: TutorialMessage[];
};

function priceFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater.`);
  return value;
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("Request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function validateChatRequest(body: unknown, defaultModel: string): TutorialChat {
  const input = record(body);
  if (!input) throw new Error("Invalid request.");
  if (typeof input.systemPrompt !== "string") throw new Error("System prompt must be text.");
  if (!Array.isArray(input.messages)) throw new Error("Messages must be an array.");

  let model = defaultModel;
  const comparison = input.model !== undefined;
  const thinking = input.reasoningEffort !== undefined;
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !COMPARISON_MODELS.has(input.model)) {
      throw new Error("That comparison model is not allowed.");
    }
    model = input.model;
  }

  const reasoningEffort = input.reasoningEffort ?? "none";
  if (reasoningEffort !== "none" && reasoningEffort !== "low" && reasoningEffort !== "high") {
    throw new Error("Reasoning effort must be none, low, or high.");
  }
  if (thinking && model !== "openai/gpt-5.6-luna") {
    throw new Error("This thinking comparison uses GPT-5.6 Luna.");
  }

  const messages = input.messages.map((value, index): TutorialMessage => {
    const message = record(value);
    if (message?.role !== "user" && message?.role !== "assistant") {
      throw new Error(`Message ${index + 1} has an invalid role.`);
    }
    if (!Array.isArray(message.content)) {
      throw new Error(`Message ${index + 1} has invalid content.`);
    }
    return {
      role: message.role,
      content: message.content.map((value): MessagePart => {
        const part = record(value);
        if (part?.type !== "text" || typeof part.text !== "string") {
          throw new Error(`Message ${index + 1} has an invalid content part.`);
        }
        return { type: "text", text: part.text };
      })
    };
  });

  return {
    model,
    comparison,
    thinking,
    reasoningEffort,
    systemPrompt: input.systemPrompt,
    messages
  };
}

function streamEvent(res: ServerResponse, event: unknown): void {
  res.write(`${JSON.stringify(event)}\n`);
}

function deltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(record)
    .filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function reasoningText(delta: Record<string, unknown> | undefined): string {
  if (typeof delta?.reasoning === "string") return delta.reasoning;
  if (!Array.isArray(delta?.reasoning_details)) return "";
  return delta.reasoning_details
    .map(record)
    .map((detail) => {
      if (detail?.type === "reasoning.summary" && typeof detail.summary === "string") {
        return detail.summary;
      }
      if (detail?.type === "reasoning.text" && typeof detail.text === "string") {
        return detail.text;
      }
      return "";
    })
    .join("");
}

function openRouterHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host ?? "localhost"}/technically-speaking/`,
    "X-Title": "Agent transcript tutorial"
  };
}

async function handleChat(req: IncomingMessage, res: ServerResponse, config: AppConfig): Promise<void> {
  let chat: TutorialChat;
  try {
    chat = validateChatRequest(await readJsonBody(req), config.openRouterModel);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400);
    return;
  }

  if (!config.openRouterApiKey) {
    sendJson(res, { error: "OpenRouter is not configured." }, 503);
    return;
  }

  const messages: Array<{ role: string; content: string | MessagePart[] }> = [];
  if (chat.systemPrompt.trim()) messages.push({ role: "system", content: chat.systemPrompt });
  messages.push(
    ...chat.messages.map((message) => ({
      role: message.role,
      content: chat.comparison ? message.content.map((part) => part.text).join("") : message.content
    }))
  );

  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const chatUrl = process.env.OPENROUTER_CHAT_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  let upstream: Response;
  try {
    upstream = await fetch(chatUrl, {
      method: "POST",
      headers: {
        ...openRouterHeaders(req, config.openRouterApiKey)
      },
      body: JSON.stringify({
        model: chat.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: chat.thinking ? 4096 : 1024,
        ...(chat.model === "openai/gpt-5.6-luna"
          ? { reasoning: { effort: chat.reasoningEffort, exclude: !chat.thinking } }
          : {})
      }),
      signal: abortController.signal
    });
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : "OpenRouter request failed." }, 502);
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let message = `OpenRouter returned ${upstream.status}.`;
    try {
      const errorBody = record(await upstream.json());
      const upstreamError = record(errorBody?.error);
      if (typeof upstreamError?.message === "string") message = upstreamError.message;
    } catch {
      // Keep the status-based error.
    }
    sendJson(res, { error: message }, 502);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Tutorial-API-Version": "4"
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneSent = false;
  let routeSent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            streamEvent(res, { type: "done" });
            doneSent = true;
            continue;
          }

          const chunk = record(JSON.parse(data));
          const streamError = record(chunk?.error);
          if (streamError) {
            streamEvent(res, {
              type: "error",
              error: typeof streamError.message === "string" ? streamError.message : "OpenRouter stream failed."
            });
            continue;
          }

          if (!routeSent && typeof chunk?.model === "string") {
            streamEvent(res, {
              type: "route",
              requestedModel: chat.model,
              servedModel: chunk.model,
              provider: typeof chunk.provider === "string" ? chunk.provider : null,
              reasoningEffort: chat.reasoningEffort
            });
            routeSent = true;
          }

          const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
          const choice = record(choices[0]);
          const delta = record(choice?.delta);
          const thinking = chat.thinking ? reasoningText(delta) : "";
          if (thinking) streamEvent(res, { type: "reasoning", text: thinking });
          const text = deltaText(delta?.content);
          if (text) streamEvent(res, { type: "delta", text });
          if (chunk?.usage) streamEvent(res, { type: "usage", usage: chunk.usage });
        }
      }
    }

    if (!doneSent) streamEvent(res, { type: "done" });
    res.end();
  } catch (error) {
    if (!res.writableEnded) {
      streamEvent(res, {
        type: "error",
        error: error instanceof Error ? error.message : "OpenRouter stream failed."
      });
      res.end();
    }
  }
}

type ToolDemoModelResponse = {
  message: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  model?: string;
  usage?: unknown;
  finishReason?: string;
};

function toolDemoRequest(
  model: string,
  messages: Array<Record<string, unknown>>,
  offerSearch: boolean
): Record<string, unknown> {
  return {
    model,
    messages,
    stream: false,
    max_completion_tokens: 1024,
    reasoning: { effort: "minimal", exclude: true },
    ...(offerSearch
      ? {
          tools: [WEB_SEARCH_TOOL],
          tool_choice: "required",
          parallel_tool_calls: false
        }
      : {})
  };
}

async function callToolDemoModel(
  req: IncomingMessage,
  config: AppConfig,
  requestBody: Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolDemoModelResponse> {
  const chatUrl = process.env.OPENROUTER_CHAT_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  const response = await fetch(chatUrl, {
    method: "POST",
    headers: openRouterHeaders(req, config.openRouterApiKey!),
    body: JSON.stringify(requestBody),
    signal
  });

  const body = record(await response.json().catch(() => undefined));
  if (!response.ok) {
    const error = record(body?.error);
    throw new Error(typeof error?.message === "string" ? error.message : `OpenRouter returned ${response.status}.`);
  }
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const choice = record(choices[0]);
  const message = record(choice?.message);
  if (!message) throw new Error("The tool demo model returned no message.");
  return {
    message,
    rawResponse: body!,
    model: typeof body?.model === "string" ? body.model : undefined,
    usage: body?.usage,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined
  };
}

function modelText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map(record)
    .filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

function toolCallFromMessage(message: Record<string, unknown>): {
  id: string;
  name: string;
  argumentsText: string;
} | undefined {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = record(calls[0]);
  const fn = record(call?.function);
  if (!call || !fn) return undefined;
  return {
    id: typeof call.id === "string" && call.id ? call.id : "tool-call-1",
    name: typeof fn.name === "string" ? fn.name : "",
    argumentsText: typeof fn.arguments === "string" ? fn.arguments : "{}"
  };
}

function toolArguments(call: { name: string; argumentsText: string }): { query: string } {
  if (call.name !== "web_search") throw new Error(`The model requested an unknown tool: ${call.name || "unnamed"}`);
  let args: Record<string, unknown> | undefined;
  try {
    args = record(JSON.parse(call.argumentsText));
  } catch {
    throw new Error("The model returned invalid web_search arguments.");
  }
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("The model returned an empty web_search query.");
  return { query: query.slice(0, 400) };
}

function bashArguments(call: { name: string; argumentsText: string }): { command: string } {
  if (call.name !== "bash") throw new Error(`The model requested an unknown tool: ${call.name || "unnamed"}`);
  let args: Record<string, unknown> | undefined;
  try {
    args = record(JSON.parse(call.argumentsText));
  } catch {
    throw new Error("The model returned invalid bash arguments.");
  }
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  if (!command) throw new Error("The model returned an empty bash command.");
  if (command.length > 12_000) throw new Error("The requested bash command is too large for this demo.");
  return { command };
}

function tutorialTrace(res: ServerResponse, event: Record<string, unknown>): void {
  streamEvent(res, { at: Date.now(), ...event });
}

async function handleToolDemo(req: IncomingMessage, res: ServerResponse, config: AppConfig): Promise<void> {
  let input: Record<string, unknown> | undefined;
  try {
    input = record(await readJsonBody(req));
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400);
    return;
  }
  const question = typeof input?.question === "string" ? input.question.trim().slice(0, 600) : "";
  const searchEnabled = input?.searchEnabled === true;
  if (!question) {
    sendJson(res, { error: "Question is required." }, 400);
    return;
  }
  if (!config.openRouterApiKey) {
    sendJson(res, { error: "OpenRouter is not configured." }, 503);
    return;
  }
  if (searchEnabled && !config.braveApiKey) {
    sendJson(res, { error: "Web search is not configured." }, 503);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Tutorial-Tool-API-Version": "1"
  });

  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const model = process.env.TECHNICALLY_SPEAKING_TOOL_MODEL?.trim() || TOOL_DEMO_MODEL;
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: TOOL_DEMO_SYSTEM_PROMPT },
    { role: "user", content: question }
  ];
  let modelCalls = 0;
  let toolCalls = 0;

  try {
    tutorialTrace(res, { type: "user_message", question });
    const firstRequest = toolDemoRequest(model, messages, searchEnabled);
    tutorialTrace(res, {
      type: "agent_model_request",
      turn: 1,
      model,
      tools: searchEnabled ? [WEB_SEARCH_TOOL] : [],
      messages: structuredClone(messages),
      request: structuredClone(firstRequest)
    });

    const first = await callToolDemoModel(req, config, firstRequest, abortController.signal);
    modelCalls += 1;

    if (!searchEnabled) {
      const answer = modelText(first.message);
      if (!answer) {
        const fallback = "The model returned no visible answer. Enable web_search so the agent can check.";
        tutorialTrace(res, {
          type: "model_no_answer",
          turn: 1,
          finishReason: first.finishReason,
          usage: first.usage,
          response: first.rawResponse
        });
        tutorialTrace(res, { type: "agent_user_response", text: fallback, generatedBy: "agent" });
        tutorialTrace(res, { type: "done", searchEnabled, modelCalls, toolCalls });
        res.end();
        return;
      }
      tutorialTrace(res, {
        type: "model_response",
        turn: 1,
        text: answer,
        finishReason: first.finishReason,
        usage: first.usage,
        response: first.rawResponse
      });
      tutorialTrace(res, { type: "agent_user_response", text: answer, generatedBy: "model" });
      tutorialTrace(res, { type: "done", searchEnabled, modelCalls, toolCalls });
      res.end();
      return;
    }

    const call = toolCallFromMessage(first.message);
    if (!call) throw new Error("The model answered without requesting web_search. Try again.");
    const args = toolArguments(call);
    toolCalls += 1;
    tutorialTrace(res, {
      type: "model_tool_call",
      turn: 1,
      toolCallId: call.id,
      name: call.name,
      arguments: args,
      response: first.rawResponse
    });
    tutorialTrace(res, { type: "agent_tool_start", toolCallId: call.id, name: call.name, arguments: args });

    const result = await executeBraveWebSearch(
      config,
      { query: args.query, max_urls: 3, max_snippets: 8, max_tokens: 2048 },
      abortController.signal
    );
    const resultText = result.content[0].text;
    tutorialTrace(res, {
      type: "agent_tool_result",
      toolCallId: call.id,
      name: call.name,
      text: resultText,
      sources: result.details.sources
    });

    const assistantToolCall = {
      role: "assistant",
      content: typeof first.message.content === "string" ? first.message.content : null,
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(args) }
        }
      ]
    };
    messages.push(assistantToolCall, {
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: resultText
    });
    const secondRequest = toolDemoRequest(model, messages, false);
    tutorialTrace(res, {
      type: "agent_model_request",
      turn: 2,
      model,
      tools: [],
      messages: structuredClone(messages),
      request: structuredClone(secondRequest)
    });

    const second = await callToolDemoModel(req, config, secondRequest, abortController.signal);
    modelCalls += 1;
    const answer = modelText(second.message);
    if (!answer) {
      const fallback =
        "The search returned sources, but the model returned no visible answer. Open the source results to inspect them.";
      tutorialTrace(res, {
        type: "model_no_answer",
        turn: 2,
        finishReason: second.finishReason,
        usage: second.usage,
        response: second.rawResponse
      });
      tutorialTrace(res, { type: "agent_user_response", text: fallback, generatedBy: "agent" });
      tutorialTrace(res, { type: "done", searchEnabled, modelCalls, toolCalls });
      res.end();
      return;
    }
    tutorialTrace(res, {
      type: "model_response",
      turn: 2,
      text: answer,
      finishReason: second.finishReason,
      usage: second.usage,
      response: second.rawResponse
    });
    tutorialTrace(res, { type: "agent_user_response", text: answer, generatedBy: "model" });
    tutorialTrace(res, { type: "done", searchEnabled, modelCalls, toolCalls });
    res.end();
  } catch (error) {
    if (!res.writableEnded) {
      tutorialTrace(res, { type: "error", error: error instanceof Error ? error.message : String(error) });
      res.end();
    }
  }
}

function vibeRequest(model: string, messages: Array<Record<string, unknown>>, toolsEnabled: boolean, first: boolean) {
  return {
    model,
    messages,
    stream: false,
    max_completion_tokens: 2048,
    reasoning: { effort: "minimal", exclude: true },
    ...(toolsEnabled
      ? {
          tools: [BASH_TOOL],
          tool_choice: first ? "required" : "auto",
          parallel_tool_calls: false
        }
      : {})
  };
}

async function handleVibeDemo(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  manager: TutorialVibeManager,
  userId: string
): Promise<void> {
  let input: Record<string, unknown> | undefined;
  try {
    input = record(await readJsonBody(req));
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400);
    return;
  }
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim().slice(0, 800) : "";
  if (!prompt) return sendJson(res, { error: "A webpage request is required." }, 400);
  if (!config.openRouterApiKey) return sendJson(res, { error: "OpenRouter is not configured." }, 503);

  let run: Awaited<ReturnType<TutorialVibeManager["begin"]>>;
  try {
    run = await manager.begin(userId);
  } catch (error) {
    return sendJson(res, { error: error instanceof Error ? error.message : String(error) }, Number(record(error)?.status) || 500);
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Tutorial-Vibe-API-Version": "1"
  });
  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  const model = process.env.TECHNICALLY_SPEAKING_VIBE_MODEL?.trim() || TOOL_DEMO_MODEL;
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: VIBE_SYSTEM_PROMPT },
    { role: "user", content: prompt }
  ];
  let modelCalls = 0;
  let toolCalls = 0;

  try {
    tutorialTrace(res, { type: "user_message", prompt });
    for (let turn = 1; turn <= VIBE_MAX_MODEL_CALLS; turn += 1) {
      const toolsEnabled = toolCalls < VIBE_MAX_TOOL_CALLS && turn < VIBE_MAX_MODEL_CALLS;
      const requestBody = vibeRequest(model, messages, toolsEnabled, turn === 1);
      tutorialTrace(res, {
        type: "agent_model_request",
        turn,
        model,
        tools: toolsEnabled ? [BASH_TOOL] : [],
        messages: structuredClone(messages),
        request: structuredClone(requestBody)
      });
      const response = await callToolDemoModel(req, config, requestBody, abortController.signal);
      modelCalls += 1;
      const call = toolCallFromMessage(response.message);
      if (!call) {
        const answer = modelText(response.message) || "The model stopped without a summary.";
        tutorialTrace(res, {
          type: "model_response",
          turn,
          text: answer,
          finishReason: response.finishReason,
          usage: response.usage,
          response: response.rawResponse
        });
        tutorialTrace(res, { type: "agent_user_response", text: answer, generatedBy: "model" });
        const files = await run.sandbox.listFiles();
        tutorialTrace(res, {
          type: "files_snapshot",
          files,
          previewReady: files.some((file) => file.path === "index.html")
        });
        tutorialTrace(res, { type: "done", modelCalls, toolCalls, expiresInMinutes: config.fly.demoIdleMinutes });
        res.end();
        return;
      }
      if (!toolsEnabled) throw new Error("The model requested another command after the demo tool limit.");
      const args = bashArguments(call);
      toolCalls += 1;
      tutorialTrace(res, {
        type: "model_tool_call",
        turn,
        toolCallId: call.id,
        name: call.name,
        arguments: args,
        response: response.rawResponse
      });
      tutorialTrace(res, { type: "agent_tool_start", toolCallId: call.id, name: call.name, arguments: args });
      const result = await run.sandbox.exec(args.command);
      const files = await run.sandbox.listFiles();
      tutorialTrace(res, {
        type: "agent_tool_result",
        toolCallId: call.id,
        name: call.name,
        text: result.output || "(no output)",
        exitCode: result.exitCode,
        files
      });
      messages.push(
        {
          role: "assistant",
          content: typeof response.message.content === "string" ? response.message.content : null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(args) }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: `Exit code: ${result.exitCode ?? "unknown"}\n${result.output || "(no output)"}`
        }
      );
    }
    throw new Error("The website demo reached its model-call limit.");
  } catch (error) {
    if (!res.writableEnded) {
      tutorialTrace(res, { type: "error", error: error instanceof Error ? error.message : String(error) });
      res.end();
    }
  } finally {
    run.release();
  }
}

function contentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "html") return "text/html; charset=utf-8";
  if (extension === "css") return "text/css; charset=utf-8";
  if (extension === "js" || extension === "mjs") return "text/javascript; charset=utf-8";
  if (extension === "json") return "application/json; charset=utf-8";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "text/plain; charset=utf-8";
}

export async function handleTechnicallySpeakingApi(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  vibeManager?: TutorialVibeManager,
  userId?: string
): Promise<void> {
  if (pathname === "/technically-speaking/api/config" && req.method === "GET") {
    sendJson(res, {
      model: config.openRouterModel,
      pricing: {
        inputPerMillion: priceFromEnvironment("OPENROUTER_INPUT_PRICE_PER_MILLION", 0.2),
        outputPerMillion: priceFromEnvironment("OPENROUTER_OUTPUT_PRICE_PER_MILLION", 1.2)
      }
    });
    return;
  }
  if (pathname === "/technically-speaking/api/chat" && req.method === "POST") {
    await handleChat(req, res, config);
    return;
  }
  if (pathname === "/technically-speaking/api/tool-demo" && req.method === "POST") {
    await handleToolDemo(req, res, config);
    return;
  }
  if (pathname === "/technically-speaking/api/vibe-demo" && req.method === "POST" && vibeManager && userId) {
    await handleVibeDemo(req, res, config, vibeManager, userId);
    return;
  }
  if (pathname === "/technically-speaking/api/vibe-demo" && req.method === "DELETE" && vibeManager && userId) {
    await vibeManager.reset(userId);
    sendJson(res, { ok: true });
    return;
  }
  if (pathname === "/technically-speaking/api/vibe-files" && req.method === "GET" && vibeManager && userId) {
    sendJson(res, { files: await vibeManager.existing(userId).listFiles() });
    return;
  }
  if (pathname === "/technically-speaking/api/vibe-file" && req.method === "GET" && vibeManager && userId) {
    const url = new URL(req.url ?? "", "http://tutorial");
    const path = url.searchParams.get("path") ?? "";
    const data = await vibeManager.existing(userId).readFile(path);
    res.writeHead(200, { "Content-Type": contentType(path), "Cache-Control": "no-store" });
    res.end(data);
    return;
  }
  const preview = /^\/technically-speaking\/api\/vibe-preview\/(.+)$/.exec(pathname);
  if (preview && req.method === "GET" && vibeManager && userId) {
    const path = decodeURIComponent(preview[1]);
    const data = await vibeManager.existing(userId).readFile(path);
    res.writeHead(200, {
      "Content-Type": contentType(path),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    res.end(data);
    return;
  }
  sendJson(res, { error: "Not found" }, 404);
}
