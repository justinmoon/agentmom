Living plan. Revise it as we learn. Do not treat this as a fixed contract.

# Migrate sandboxes from smolvm to Fly Machines

## Intent

Stop operating VM infrastructure. Sandboxes become Fly Machines
(machine-per-workspace, volume-backed, stop after ~10 min idle, wake on
access). Delete all smolvm mechanics. Users keep their data and notice
nothing except slightly different cold-start behavior.

## Scope

- Executor becomes `local | fly` (smolvm deleted).
- Server stays on mom-stage-1 (Hetzner). Moving the server to Fly is
  explicitly out of scope.
- Deployments (`mom deploy`, podman on the server) stay as they are,
  except the build context is now pulled from the machine.
- Migrate all 13 existing workspaces' project data into machine volumes.

## Architecture (decided)

- **App-per-workspace**: Fly app `am-ws-<first 16 hex of workspace id>`,
  one machine + one volume (10GB, region arn, mounted /workspace),
  image docker.io/library/node:24-bookworm (same as smolvm guest),
  machine env HOME=/workspace (preserves the skills fix).
  Per-app fly.dev hostname → no per-machine routing tricks needed;
  fly-proxy autostart=true wakes stopped machines on incoming preview
  traffic. autostop OFF — the server owns the 10-min idle stop so a
  machine never dies between bash calls mid-turn.
- **Shim, self-bootstrapping**: machine init runs
  `sh -c "curl -fsSL https://agentmom.xyz/api/sandbox-shim -o /tmp/shim.mjs && node /tmp/shim.mjs"`.
  No custom image, no registry; shim updates ship with server deploys
  (machines pick them up on next cold boot). Shim = single-file node
  HTTP server on :8080 with bearer auth:
  - POST /exec {command,cwd,timeout} → streamed NDJSON (out/err chunks,
    final exit record)
  - POST /spawn {command,cwd} → detached long-running process (dev
    servers for mom serve), logs to /tmp
  - GET/PUT file ops: read (base64 for buffers), write, mkdir, access,
    stat
  - POST /proxy {port,method,path,headers,body} → forward to
    localhost:port inside the machine (previews)
  - GET /tar?path=&since= → tar stream (full or mtime-incremental)
  - POST /untar?path= → extract uploaded tar (data migration, pushes)
  - GET /health
  Auth token = HMAC-SHA256(flyApiToken, workspaceId) — derived, not
  stored; set as machine env, computed server-side.
- **Single source of truth for files = the machine.** Pi's read/write/
  edit/bash all run against the machine via pluggable Operations
  (createReadToolDefinition etc. take `operations`; custom tools
  override built-ins by name — verified in pi dist). This preserves
  mid-turn coherence between bash and file tools.
- **Host mirror** (the old projectsDir) becomes a read-mostly cache for
  server-side consumers, refreshed by mtime-incremental tar pull:
  - at agent_end (before auto-preview + skills reload)
  - deployment registration pulls that project dir fresh before build
  - skills pane writes go through the shim to the machine, then refresh
    the mirror
  - attachments: written via shim into /workspace/.agentmom/uploads
    (visiblePath = /workspace/...)
- **Wake/idle**: bridge starts machine (fire-and-forget) as soon as a
  user message arrives — boot (~1.6s) overlaps the LLM call. Preview
  fetches ensure-started too (fly autostart is the backstop). Idle
  timer: stop machine via API after `fly.idleMinutes` (default 10) of
  no activity, never while a turn is running.
- **Secrets**: FLY_API_TOKEN as a NEW standalone agenix secret
  (nix/secrets/fly-api-token.age) — encrypted with age against the
  existing recipients' public keys (no decryption of secrets.age
  needed). Loaded via LoadCredential, exposed as env var path.
- **Migration**: script iterates catalog workspaces: create app+volume+
  machine, wait for shim, push tar of host projectsDir → /workspace.
  Old host files stay in place as the initial mirror.

## Spike numbers (2026-07-21, laptop→arn)

provision 6.2s once; API cold start ~1.6s; autostart-on-request ~5s
e2e; warm exec p50 156ms from US laptop = RTT-dominated (Hetzner-FI →
arn should be ~15-25ms).

## Steps (ALL DONE 2026-07-21)

- [x] Everything shipped: shim, FlySandbox, config, pi-bridge
      integration, migration script, smolvm deletion, nix secret.
- [x] Validated: smoke:fly against a real machine (exec/file/spawn/
      proxy/tar/HOME/wake-with-volume); real LLM turn locally with all
      four tools coherent against the machine + mirror pull verified;
      all other smokes green; full closure build.
- [x] Deployed (executor=fly), all 13 workspaces migrated (~20s each,
      zero failures), data verified in-machine (justin's skills
      present). Machines stopped post-migration; they wake on demand.
- [x] Old smolvm VM + caches removed from the server (2.3G freed).
- [ ] Watch: idle-stop at 10m during real use; users' first turns
      (report any missing guest-installed packages — expected, agents
      reinstall).

## Gotchas hit (for posterity)

- `fly tokens create org` silently writes NOTHING without the org slug
  when non-interactive — always verify secret byte counts.
- Freshly created machines auto-boot; explicit start gets 412
  "current state: 'created'" (benign).
- New-app fly.dev routing takes ~20-30s to propagate — provision is
  ~30s one-time; subsequent wakes are seconds.
- esbuild/tsx spawn fails EACCES if cwd is unreadable by the service
  user.

## Implementation Notes

- pi customTools override built-ins by name (agent-session.js
  _refreshToolRegistry). Operations interfaces: ReadOperations
  {readFile, access, detectImageMimeType?}, WriteOperations {writeFile,
  mkdir}, EditOperations {readFile, writeFile, access}, BashOperations
  {exec streaming}.
- Machines API quirks: wait endpoint timeout max 60s; exec API exists
  but routes through control plane (slow) — use shim for everything.
- fly CLI authenticated as mail@justinmoon.com; spike app
  agentmom-sandbox-spike kept for scratch testing.
