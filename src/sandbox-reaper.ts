import type { CatalogStore } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { flyAppName } from "./fly-machines.js";
import type { WorkspaceRuntimeManager } from "./workspace-runtime.js";

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Safety net for sandbox machines the per-workspace idle timers can't see:
 * machines started out-of-band (migrations, manual starts) or left running
 * across a server restart. Sweeps every org app with our prefix and stops
 * any started machine whose workspace isn't legitimately busy. Wake-on-demand
 * plus persistent volumes make a false stop harmless.
 */
export function startSandboxReaper(
  config: AppConfig,
  catalog: CatalogStore,
  runtimes: WorkspaceRuntimeManager
): void {
  if (config.executor !== "fly" || !config.fly.token) return;

  setInterval(() => {
    void sweep().catch(() => {});
  }, SWEEP_INTERVAL_MS).unref();

  async function api(method: string, path: string): Promise<any> {
    const response = await fetch(`https://api.machines.dev/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.fly.token}`, "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined
    });
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  async function sweep(): Promise<void> {
    const listing = (await api("GET", `/apps?org_slug=${encodeURIComponent(config.fly.org)}`)) as {
      apps?: Array<{ name: string }>;
    };
    const workspaces = catalog.read().workspaces;

    for (const app of listing.apps ?? []) {
      if (!app.name.startsWith(config.fly.appPrefix)) continue;
      const machines = (await api("GET", `/apps/${app.name}/machines`)) as Array<{ id: string; state: string }>;

      for (const machine of machines) {
        if (machine.state !== "started") continue;

        const workspace = workspaces.find((entry) => flyAppName(config.fly.appPrefix, entry.id) === app.name);
        const runtime = workspace ? await runtimes.peek(workspace.id) : undefined;
        if (runtime?.bridge.isSandboxBusy()) continue;

        await api("POST", `/apps/${app.name}/machines/${machine.id}/stop`).catch(() => {});
        console.log(`sandbox reaper: stopped idle machine ${machine.id} (${app.name})`);
      }
    }
  }
}
