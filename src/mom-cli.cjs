#!/usr/bin/env node

const { previewSentinel, deploySentinel } = require("./mom-cli-protocol.json");
const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail(
    "Usage:\n" +
      "  mom expose <port> <name>\n" +
      "  mom serve <port> <name> -- <command>\n" +
      "  mom deploy --cwd <absolute-path> --slug <slug> --port <port>   (containerized app; needs a Dockerfile)\n" +
      "  mom deploy --cwd <absolute-path> --slug <slug> [--static <dir>] (static site; no Dockerfile needed)"
  );
}

function parsePort(value) {
  const rawPort = String(value || "").trim();
  if (!/^\d+$/.test(rawPort)) usage();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
  return port;
}

function readOption(name) {
  const prefix = `--${name}=`;
  const equalsArg = args.find((arg) => arg.startsWith(prefix));
  if (equalsArg) return equalsArg.slice(prefix.length).trim();

  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) usage();
  const value = args[index + 1].trim();
  if (!value || value.startsWith("--")) usage();
  return value;
}

function readRequiredOption(name) {
  const value = readOption(name);
  if (value === undefined) usage();
  return value;
}

function assertNoUnexpectedDeployArgs() {
  const allowed = new Set(["--cwd", "--port", "--slug", "--static"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--cwd=") || arg.startsWith("--port=") || arg.startsWith("--slug=") || arg.startsWith("--static=")) continue;
    if (!allowed.has(arg)) usage();
    index += 1;
  }
}

if (command === "expose") {
  const port = parsePort(args[0]);
  const name = args.slice(1).join(" ").trim();
  if (!name) usage();

  console.log(previewSentinel + JSON.stringify({ port, name }));
  console.log(`Preview exposed: ${name} on port ${port}`);
  process.exit(0);
}

if (command === "serve") {
  const port = parsePort(args[0]);
  const separator = args.indexOf("--");
  if (separator < 2 || separator === args.length - 1) usage();

  const name = args.slice(1, separator).join(" ").trim();
  const serveCommand = args.slice(separator + 1).join(" ").trim();
  if (!name || !serveCommand) usage();

  console.log(previewSentinel + JSON.stringify({ port, name, cwd: process.cwd(), command: serveCommand }));
  console.log(`Preview server requested: ${name} on port ${port}`);
  process.exit(0);
}

if (command === "deploy") {
  assertNoUnexpectedDeployArgs();
  const cwd = readRequiredOption("cwd");
  const slug = readRequiredOption("slug");
  const rawStatic = readOption("static");
  const rawPort = readOption("port");
  if (!cwd.startsWith("/")) fail("mom deploy requires --cwd to be an absolute path");
  if (!slug) usage();
  if (rawStatic !== undefined && rawStatic.startsWith("/")) {
    fail("mom deploy --static takes a directory relative to --cwd (e.g. --static dist)");
  }

  const payload = { cwd, slug };
  if (rawStatic !== undefined) payload.static = rawStatic;
  if (rawPort !== undefined) payload.port = parsePort(rawPort);

  console.log(deploySentinel + JSON.stringify(payload));
  console.log(`Deployment requested: ${slug} from ${cwd}`);
  process.exit(0);
}

usage();
