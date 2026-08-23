import type { UiEvent } from "../src/types.js";

export type AgentLoopExchange = {
  id: string;
  toolName: string;
  requestedAt?: string;
  requestDetail?: string;
  startedAt?: string;
  argumentsDetail?: string;
  finishedAt?: string;
  resultDetail?: string;
  isError: boolean;
};

export function buildAgentLoop(events: UiEvent[]): AgentLoopExchange[] {
  const exchanges: AgentLoopExchange[] = [];
  const byCallId = new Map<string, AgentLoopExchange>();

  for (const event of [...events].reverse()) {
    const request = /^Model requested ([A-Za-z][\w-]*)$/.exec(event.title);
    const started = /^([A-Za-z][\w-]*) started$/.exec(event.title);
    const finished = /^([A-Za-z][\w-]*) (finished|failed)$/.exec(event.title);
    if (!request && !started && !finished) continue;

    const toolName = request?.[1] ?? started?.[1] ?? finished?.[1] ?? "tool";
    const callId = event.toolCallId ?? event.id;
    let exchange = byCallId.get(callId);
    if (!exchange) {
      exchange = { id: callId, toolName, isError: false };
      byCallId.set(callId, exchange);
      exchanges.push(exchange);
    }

    if (request) {
      exchange.toolName = toolName;
      exchange.requestedAt = event.createdAt;
      exchange.requestDetail = event.detail;
    } else if (started) {
      exchange.startedAt = event.createdAt;
      exchange.argumentsDetail = event.detail;
    } else {
      exchange.finishedAt = event.createdAt;
      exchange.resultDetail = event.detail;
      exchange.isError = Boolean(event.isError || finished?.[2] === "failed");
    }
  }

  return exchanges;
}

export function requestSummary(exchange: AgentLoopExchange): string {
  const request = parseRecord(exchange.requestDetail);
  const args = asRecord(request?.arguments) ?? parseRecord(exchange.argumentsDetail);
  if (!args) return "Structured arguments";

  const primary = pickString(args, ["command", "path", "query", "url"]);
  if (primary) return truncate(primary, 180);
  return truncate(JSON.stringify(args), 180);
}

export function resultSummary(exchange: AgentLoopExchange): string {
  if (!exchange.resultDetail) return exchange.startedAt ? "Running…" : "Waiting to run…";
  const result = parseRecord(exchange.resultDetail);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((part) => asRecord(part))
    .map((part) => pickString(part ?? {}, ["text"]))
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const direct = result ? pickString(result, ["output", "stdout", "message", "error"]) : undefined;
  const summary = text || direct;
  if (summary) return truncate(summary.replace(/\s+/g, " ").trim(), 220);
  return exchange.isError ? "Tool failed" : "Tool completed";
}

export function prettyDetail(detail: string | undefined): string {
  if (!detail) return "";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
