// Agent Mom sandbox shim. Runs inside a Fly Machine, serves the server's
// exec/file/proxy/tar needs on :8080. Self-bootstrapped at machine init via
// curl from the Agent Mom server, so it must stay a single dependency-free
// file that runs on stock node:24.
//
// Auth: every request needs `authorization: Bearer $AGENTMOM_SHIM_TOKEN`
// (set in the machine's env at creation).

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { dirname, resolve } from "node:path";

const PORT = 8080;
const TOKEN = process.env.AGENTMOM_SHIM_TOKEN ?? "";
const ROOT = process.env.AGENTMOM_WORKSPACE ?? "/workspace";

if (!TOKEN) {
  console.error("AGENTMOM_SHIM_TOKEN is required");
  process.exit(1);
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(TOKEN).digest();
  return timingSafeEqual(a, b);
}

function jailPath(rawPath) {
  const path = resolve(String(rawPath ?? ""));
  if (path !== ROOT && !path.startsWith(`${ROOT}/`) && !path.startsWith("/tmp/")) {
    throw Object.assign(new Error(`path outside ${ROOT}: ${path}`), { status: 400 });
  }
  return path;
}

function readBody(req, maxBytes = 512 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function handleExec(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const command = String(body.command ?? "");
  const cwd = jailPath(body.cwd ?? ROOT);
  const timeout = Math.min(Number(body.timeout ?? 600_000), 3_600_000);

  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    env: { ...process.env, HOME: ROOT },
    detached: false
  });

  const send = (record) => res.write(`${JSON.stringify(record)}\n`);
  child.stdout.on("data", (data) => send({ o: data.toString("base64") }));
  child.stderr.on("data", (data) => send({ e: data.toString("base64") }));

  const timer = setTimeout(() => {
    send({ t: true });
    child.kill("SIGKILL");
  }, timeout);
  req.on("close", () => {
    // Server hung up (abort): kill the command.
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    send({ x: exitCode });
    res.end();
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    send({ err: String(error), x: 127 });
    res.end();
  });
}

async function handleSpawn(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const command = String(body.command ?? "");
  const cwd = jailPath(body.cwd ?? ROOT);
  const logPath = `/tmp/agentmom-spawn-${Date.now().toString(36)}.log`;
  const log = createWriteStream(logPath);
  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    env: { ...process.env, HOME: ROOT },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.unref();
  sendJson(res, 200, { pid: child.pid, log: logPath });
}

async function handleFile(req, res, url) {
  const path = jailPath(url.searchParams.get("path"));
  if (req.method === "GET") {
    const action = url.searchParams.get("op") ?? "read";
    if (action === "access") {
      await access(path);
      return sendJson(res, 200, { ok: true });
    }
    if (action === "stat") {
      const stats = statSync(path);
      return sendJson(res, 200, { size: stats.size, mtimeMs: stats.mtimeMs, dir: stats.isDirectory() });
    }
    const data = await readFile(path);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(data);
  }
  if (req.method === "PUT") {
    const data = await readBody(req);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, data);
    return sendJson(res, 200, { ok: true, bytes: data.length });
  }
  if (req.method === "POST" && url.searchParams.get("op") === "mkdir") {
    await mkdir(path, { recursive: true });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

async function handleProxy(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, 400, { error: "invalid port" });
  }
  const upstream = await fetch(`http://127.0.0.1:${port}${body.path ?? "/"}`, {
    method: body.method ?? "GET",
    headers: body.headers ?? {},
    body: body.bodyBase64 ? Buffer.from(body.bodyBase64, "base64") : undefined,
    redirect: "manual"
  }).catch((error) => ({ error: String(error) }));
  if (upstream.error) return sendJson(res, 502, { error: upstream.error });
  const data = Buffer.from(await upstream.arrayBuffer());
  sendJson(res, 200, {
    status: upstream.status,
    headers: Object.fromEntries(upstream.headers.entries()),
    bodyBase64: data.toString("base64")
  });
}

function handleTar(_req, res, url) {
  const path = jailPath(url.searchParams.get("path") ?? ROOT);
  const sinceMs = Number(url.searchParams.get("since") ?? 0);
  // -N takes a date; tar from bookworm supports @epoch via `--newer-mtime`.
  const newer = sinceMs > 0 ? `--newer-mtime="@${Math.floor(sinceMs / 1000)}" ` : "";
  const command = `tar -C ${JSON.stringify(path)} ${newer}--exclude=node_modules --exclude=.git/objects --warning=no-file-changed -czf - . || [ $? -eq 1 ]`;
  res.writeHead(200, { "content-type": "application/gzip" });
  const child = spawn("/bin/bash", ["-c", command]);
  child.stdout.pipe(res);
  child.on("error", () => res.end());
}

async function handleUntar(req, res, url) {
  const path = jailPath(url.searchParams.get("path") ?? ROOT);
  mkdirSync(path, { recursive: true });
  const child = spawn("tar", ["-C", path, "-xzf", "-"], { stdio: ["pipe", "ignore", "pipe"] });
  req.pipe(child.stdin);
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d));
  child.on("close", (code) => {
    if (code === 0) sendJson(res, 200, { ok: true });
    else sendJson(res, 500, { error: Buffer.concat(stderr).toString("utf8").slice(0, 500) });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://shim");
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, root: ROOT });
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });

    if (url.pathname === "/exec" && req.method === "POST") return await handleExec(req, res);
    if (url.pathname === "/spawn" && req.method === "POST") return await handleSpawn(req, res);
    if (url.pathname === "/file") return await handleFile(req, res, url);
    if (url.pathname === "/proxy" && req.method === "POST") return await handleProxy(req, res);
    if (url.pathname === "/tar" && req.method === "GET") return handleTar(req, res, url);
    if (url.pathname === "/untar" && req.method === "POST") return await handleUntar(req, res, url);
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
    } else {
      res.end();
    }
  }
});

mkdirSync(ROOT, { recursive: true });
server.listen(PORT, "0.0.0.0", () => {
  console.log(`agentmom shim on :${PORT}, root ${ROOT}`);
});
