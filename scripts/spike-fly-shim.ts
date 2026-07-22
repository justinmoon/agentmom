/**
 * Spike part 2: exec latency through an in-machine shim (the real executor path)
 * and end-to-end autostart wake (request to a stopped machine).
 *
 * Usage: FLY_API_TOKEN=$(fly auth token) tsx scripts/spike-fly-shim.ts
 * Requires a shared v4 IP on the app: fly ips allocate-v4 --shared -a agentmom-sandbox-spike
 */

export {};

const API = "https://api.machines.dev/v1";
const TOKEN = process.env.FLY_API_TOKEN?.trim();
const APP = process.env.FLY_SPIKE_APP ?? "agentmom-sandbox-spike";
const REGION = process.env.FLY_SPIKE_REGION ?? "arn";

if (!TOKEN) {
  console.error("FLY_API_TOKEN is required (fly auth token)");
  process.exit(1);
}

// Minimal exec shim: POST {"c": "<command>"} -> {"x": exitCode, "o": stdout, "r": stderr}
const SHIM = `require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{try{const{c}=JSON.parse(b||"{}");require("child_process").exec(c,{timeout:30000},(e,o,r)=>s.end(JSON.stringify({x:e?(e.code??1):0,o,r})))}catch(err){s.statusCode=400;s.end(String(err))}})}).listen(8080)`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function shimExec(command: string, timeoutMs = 35_000): Promise<{ x: number; o: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${APP}.fly.dev/`, {
      method: "POST",
      body: JSON.stringify({ c: command }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`shim ${response.status}`);
    return (await response.json()) as { x: number; o: string };
  } finally {
    clearTimeout(timer);
  }
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `p50=${pick(0.5)}ms p95=${pick(0.95)}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms (n=${samples.length})`;
}

let machineId: string | undefined;

try {
  const machine = await api("POST", `/apps/${APP}/machines`, {
    name: `shim-${Date.now().toString(36)}`,
    region: REGION,
    config: {
      image: "docker.io/library/node:24-slim",
      guest: { cpu_kind: "shared", cpus: 2, memory_mb: 1024 },
      init: { exec: ["/usr/local/bin/node", "-e", SHIM] },
      services: [
        {
          protocol: "tcp",
          internal_port: 8080,
          autostart: true,
          autostop: "stop",
          ports: [
            { port: 80, handlers: ["http"] },
            { port: 443, handlers: ["tls", "http"] }
          ]
        }
      ],
      auto_destroy: false
    }
  });
  machineId = machine.id as string;
  await api("GET", `/apps/${APP}/machines/${machineId}/wait?state=started&timeout=60`);

  // Wait for shim + edge routing to come up
  let t = Date.now();
  for (;;) {
    try {
      const result = await shimExec("echo ready", 3000);
      if (result.x === 0) break;
    } catch {
      /* retry */
    }
    if (Date.now() - t > 90_000) throw new Error("shim never became reachable via fly.dev");
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`shim reachable ${Date.now() - t}ms after machine start`);

  // 1. Warm exec latency through the shim (the real per-bash-call path)
  const warm: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    t = Date.now();
    const result = await shimExec("echo hi");
    if (result.x !== 0) throw new Error("warm shim exec failed");
    warm.push(Date.now() - t);
  }
  console.log(`1. warm exec via shim: ${stats(warm.slice(5))}`);

  // 2. Autostart: stop the machine, then just send a request — fly-proxy should wake it.
  const wakes: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await api("POST", `/apps/${APP}/machines/${machineId}/stop`, {});
    await api("GET", `/apps/${APP}/machines/${machineId}/wait?state=stopped&timeout=60`);
    await new Promise((r) => setTimeout(r, 2000)); // let the proxy notice
    t = Date.now();
    const result = await shimExec("echo woke", 30_000);
    if (result.x !== 0) throw new Error("autostart exec failed");
    wakes.push(Date.now() - t);
    console.log(`2. autostart wake #${i + 1}: request->response ${wakes[wakes.length - 1]}ms`);
  }

  console.log("\nsummary:");
  console.log(`  warm exec via shim:      ${stats(warm.slice(5))}`);
  console.log(`  autostart wake (e2e):    ${stats(wakes)}`);
} finally {
  if (machineId) {
    await api("DELETE", `/apps/${APP}/machines/${machineId}?force=true`).catch(() => {});
    console.log(`cleaned up machine ${machineId}`);
  }
}
