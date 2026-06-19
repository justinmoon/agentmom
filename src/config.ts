import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  host: string;
  port: number;
  workspace: string;
  agentDir: string;
  sessionDir: string;
  openRouterModel: string;
  openRouterEnvFile: string;
  openRouterApiKey?: string;
  piPath: string;
  assistantUiPath: string;
  rootDir: string;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFileValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  return undefined;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig(): AppConfig {
  const workspace = resolve(process.env.AGENTGRANNY_WORKSPACE ?? process.cwd());
  const openRouterEnvFile = resolve(process.env.AGENTGRANNY_OPENROUTER_ENV_FILE ?? `${rootDir}/.env`);
  const openRouterApiKey =
    process.env.OPENROUTER_API_KEY ?? readEnvFileValue(openRouterEnvFile, "OPENROUTER_API_KEY");

  if (openRouterApiKey && !process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = openRouterApiKey;
  }

  const stateDir = resolve(process.env.AGENTGRANNY_STATE_DIR ?? `${workspace}/.agentgranny2`);

  return {
    host: process.env.AGENTGRANNY_HOST ?? "127.0.0.1",
    port: numberFromEnv("AGENTGRANNY_PORT", 7392),
    workspace,
    agentDir: resolve(process.env.AGENTGRANNY_AGENT_DIR ?? `${stateDir}/pi`),
    sessionDir: resolve(process.env.AGENTGRANNY_SESSION_DIR ?? `${stateDir}/sessions`),
    openRouterModel: process.env.AGENTGRANNY_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
    openRouterEnvFile,
    openRouterApiKey,
    piPath: resolve(process.env.AGENTGRANNY_PI_PATH ?? "/Users/justin/code/pi-mono"),
    assistantUiPath: resolve(
      process.env.AGENTGRANNY_ASSISTANT_UI_PATH ?? "/Users/justin/code/assistant-ui"
    ),
    rootDir
  };
}
