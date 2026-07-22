/**
 * Spike: measure Fly Machines as a candidate agentmom sandbox executor.
 *
 * Standalone — talks straight to the Machines API; touches nothing in the app.
 * Usage: FLY_API_TOKEN=$(fly auth token) tsx scripts/spike-fly.ts
 *
 * Measures, for a stock node image in one region:
 *   1. provision   — create machine -> started (first-ever boot, image pull)
 *   2. warm exec   — p50/p95 over repeated small commands (the per-bash-call tax)
 *   3. cold start  — stop -> start -> first successful exec (the scale-to-zero wake)
 *   4. real-ish    — npm --version and a small node script, warm
 */

export {};

const API = "https://api.machines.dev/v1";
const TOKEN = process.env.FLY_API_TOKEN?.trim();
const APP = process.env.FLY_SPIKE_APP ?? "agentmom-sandbox-spike";
const ORG = process.env.FLY_SPIKE_ORG ?? "personal";
const REGION = process.env.FLY_SPIKE_REGION ?? "arn";
const IMAGE = process.env.FLY_SPIKE_IMAGE ?? "docker.io/library/node:24-slim";
const KEEP = process.env.FLY_SPIKE_KEEP === "1";

if (!TOKEN) {
  console.error("FLY_API_TOKEN is required (fly auth token)");
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function exec(machineId: string, command: string, timeout = 30): Promise<{ ok: boolean; out: string }> {
  const result = await api("POST", `/apps/${APP}/machines/${machineId}/exec`, {
    command: ["/bin/sh", "-c", command],
    timeout
  });
  return { ok: (result.exit_code ?? 1) === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

async function waitState(machineId: string, state: string): Promise<void> {
  // The wait endpoint caps timeout at 60s; loop it for slower first boots.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api("GET", `/apps/${APP}/machines/${machineId}/wait?state=${state}&timeout=60`);
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/** First exec after start can race guest boot; retry until it lands. */
async function execUntilReady(machineId: string, deadlineMs = 60_000): Promise<number> {
  const begin = Date.now();
  for (;;) {
    try {
      const result = await exec(machineId, "echo ready", 5);
      if (result.ok) return Date.now() - begin;
    } catch {
      // keep polling
    }
    if (Date.now() - begin > deadlineMs) throw new Error("machine never became exec-able");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `p50=${pick(0.5)}ms p95=${pick(0.95)}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms (n=${samples.length})`;
}

let machineId: string | undefined;

try {
  // App is idempotent-ish: 422 "already exists" is fine.
  await api("POST", "/apps", { app_name: APP, org_slug: ORG }).catch((error) => {
    if (!String(error).includes("taken") && !String(error).includes("exists")) throw error;
  });
  console.log(`app: ${APP} (org=${ORG}, region=${REGION}, image=${IMAGE})`);

  // 1. Provision: create -> started -> exec-able (includes image pull on first boot)
  let t = Date.now();
  const machine = await api("POST", `/apps/${APP}/machines`, {
    name: `spike-${Date.now().toString(36)}`,
    region: REGION,
    config: {
      image: IMAGE,
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 1024 },
      init: { exec: ["/bin/sleep", "inf"] },
      auto_destroy: false
    }
  });
  machineId = machine.id as string;
  await waitState(machineId, "started");
  const startedAt = Date.now() - t;
  const execReadyMs = await execUntilReady(machineId);
  console.log(`\n1. provision: create->started ${startedAt}ms, +${execReadyMs}ms to first exec`);

  // 2. Warm exec latency
  const warm: number[] = [];
  for (let i = 0; i < 25; i += 1) {
    t = Date.now();
    const result = await exec(machineId, "echo hi");
    if (!result.ok) throw new Error(`warm exec failed: ${result.out}`);
    warm.push(Date.now() - t);
  }
  console.log(`2. warm exec (echo): ${stats(warm.slice(5))}`); // drop first 5 as warmup

  // 3. Cold start cycles: stop -> start -> exec-able
  const cold: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await api("POST", `/apps/${APP}/machines/${machineId}/stop`, {});
    await waitState(machineId, "stopped");
    t = Date.now();
    await api("POST", `/apps/${APP}/machines/${machineId}/start`, {});
    await execUntilReady(machineId);
    cold.push(Date.now() - t);
    console.log(`3. cold start #${i + 1}: stop->start->exec ${cold[cold.length - 1]}ms`);
  }

  // 4. Real-ish workload, warm
  t = Date.now();
  const npmVersion = await exec(machineId, "npm --version", 60);
  console.log(`4. npm --version: ${Date.now() - t}ms (${npmVersion.out})`);
  t = Date.now();
  const nodeRun = await exec(machineId, "node -e 'console.log([...Array(5)].map((_,i)=>i*i).join())'");
  console.log(`   node script: ${Date.now() - t}ms (${nodeRun.out})`);

  console.log("\nsummary:");
  console.log(`  provision (first boot):   ${startedAt + execReadyMs}ms`);
  console.log(`  cold start (wake):        ${stats(cold)}`);
  console.log(`  warm per-command overhead:${stats(warm.slice(5))}`);
} finally {
  if (machineId && !KEEP) {
    await api("DELETE", `/apps/${APP}/machines/${machineId}?force=true`).catch(() => {});
    console.log(`cleaned up machine ${machineId} (app ${APP} kept for reruns)`);
  } else if (machineId) {
    console.log(`kept machine ${machineId} (FLY_SPIKE_KEEP=1)`);
  }
}
