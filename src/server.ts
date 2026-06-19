import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { loadConfig } from "./config.js";
import { PiBridge } from "./pi-bridge.js";
import type { AppState } from "./types.js";

const config = loadConfig();
const bridge = new PiBridge(config);
const isProduction = process.env.NODE_ENV === "production";

let vite: ViteDevServer | undefined;
if (!isProduction) {
  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
}

await bridge.init();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${config.host}:${config.port}`}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        workspace: config.workspace,
        agentCwd: config.agentCwd,
        executor: config.executor
      });
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, await bridge.snapshot());
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return sendJson(res, { sessions: await bridge.listSessions() });
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJson(req);
      const state = await bridge.openSession(
        body?.path ? { kind: "open", path: String(body.path) } : body?.new ? { kind: "new" } : { kind: "continue" }
      );
      return sendJson(res, state);
    }

    if (url.pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      if (!body?.content || typeof body.content !== "string") {
        return sendJson(res, { error: "content is required" }, 400);
      }
      return sendJson(res, await bridge.sendMessage(body.content));
    }

    if (url.pathname === "/api/cancel" && req.method === "POST") {
      return sendJson(res, await bridge.cancel());
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return handleSse(res);
    }

    if (vite) {
      return vite.middlewares(req, res, (error?: unknown) => {
        if (error) {
          vite?.ssrFixStacktrace(error as Error);
          sendError(res, error);
        } else {
          sendError(res, new Error("Not found"), 404);
        }
      });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`agentgranny2 listening on http://${config.host}:${config.port}`);
  console.log(`workspace=${config.workspace}`);
  console.log(`agentCwd=${config.agentCwd}`);
  console.log(`executor=${config.executor}`);
  console.log(`model=openrouter/${config.openRouterModel}`);
});

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function handleSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (state: AppState) => {
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  };

  const unsubscribe = bridge.subscribe(send);
  res.on("close", unsubscribe);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, error: unknown, status = 500): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, { error: message }, status);
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(config.rootDir, "dist/client", relative);
  if (!existsSync(filePath)) return sendError(res, new Error("Not found"), 404);

  const mime =
    extname(filePath) === ".html"
      ? "text/html"
      : extname(filePath) === ".js"
        ? "text/javascript"
        : extname(filePath) === ".css"
          ? "text/css"
          : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}

async function shutdown(): Promise<void> {
  bridge.dispose();
  await vite?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

export const serverUrl = pathToFileURL(config.rootDir).toString();
