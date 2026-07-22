Living plan. Revise it as we learn. Do not treat this as a fixed contract.

# Migrate prod from mom-1 to mom-stage-1 (single-box end state)

## Intent

mom-1 (32c/128G/3.5T Hetzner) is oversized and we don't need a separate
staging environment. End state: one box (current mom-stage-1 hardware,
16c/62G/~1.9T) running prod at agentmom.xyz; mom-1 cancelled.

## Scope

- Move: agentmom service, catalog/users, sessions, skills, workspace
  projects, deployment records/static files, secrets, telegram bot.
- Not moving: smolvm VM disks (see decision below), regenerable caches
  (`xdg-cache`), `/data/android` on mom-1 (288G, NOT agentmom — needs its
  own disposition before the server is cancelled).
- User handles all DNS changes.

## Approach

- Keep the exact same filesystem layout (`/data/agentmom-web/...`) on the
  new box — state files contain absolute paths (deployments.json
  projectPath, session cwd, smolvm db); identical paths mean zero fixups.
- **Decision: do not migrate smolvm machine disks.** PiBridge recreates
  missing machines on demand, and since the HOME=/workspace fix, durable
  agent state (projects, skills, gitconfig) lives in the mounted workspace,
  not the VM disk. Guest-installed apt/npm packages are lost; agents
  reinstall them. This shrinks the real migration payload to ~2G
  (app state + workspace dirs).
- Telegram bot is a long-polling singleton: the token must be live on at
  most one host at a time. New host runs with telegram disabled until
  cutover.
- TLS is on-demand (Caddy + /api/tls-ask): certs re-issue automatically on
  the new host after DNS flips; nothing to migrate.
- Memory: 9 workspaces x 8G VM ceiling nominally exceeds 62G. Allocation
  is lazy (mom-1 showed ~47G used total), but set
  `AGENTMOM_SMOLVM_MEMORY_MB=4096` on the new host and watch headroom for
  a week before calling it done.

## Steps

### Phase 0 — pre-flight (no downtime)

- [ ] User: lower DNS TTL on `agentmom.xyz` A record and `*.agentmom.xyz`
      wildcard to 300s (do this >=24h before cutover).
- [ ] Decide disposition of `/data/android` on mom-1 (blocks
      decommission, not cutover).
- [x] Re-encrypt prod agenix secrets — NOT NEEDED: secrets.age was
      already encrypted for both host keys.
- [x] Stage host prepped: smolvm.memoryMb=4096, telegram suppressed via
      new `AGENTMOM_TELEGRAM_DISABLED=1` app flag (empty-token approach
      fails requireServiceSecrets), dead MOM_ENABLE_TEST_ENDPOINTS
      removed. Service active + healthy. Domain stays stage.agentmom.xyz
      until cutover (Caddy can't issue agentmom.xyz certs before DNS).
- [x] Rehearsal rsync done: 1.17G in ~14s (81MB/s) via migration key
      (mom-1:/home/justin/.ssh/id_migration → justin@100.73.239.5,
      sudo rsync both ends). Dress rehearsal: stage restarted on the
      copied data — catalog, workspaces, and skills all load; ownership
      mapped correctly by name.

### Phase 1 — cutover (maintenance window, ~15–30 min)

- [ ] Stop agentmom on mom-1; stop all smolvm machines; disable the
      service (`systemctl disable --now`) so nothing revives it.
- [ ] Wipe stage's old `/data/agentmom-web/{app,workspace}`; final
      `rsync -a --delete` of both dirs from mom-1.
- [ ] Switch mom-stage-1 to the prodHost module (agentmom.xyz domains),
      drop AGENTMOM_TELEGRAM_DISABLED, deploy, restart agentmom.
- [ ] User: flip DNS — `agentmom.xyz` A and `*.agentmom.xyz` →
      135.181.179.143.
- [ ] Verify (see checklist in notes): health, login as real user,
      agent turn in a workspace, skills list/picker, preview, static +
      container deploy, TLS on a deployment subdomain, telegram message.
- [ ] Leave mom-1's agentmom stopped+disabled (stale-DNS visitors get
      connection errors, not a split-brain second prod).

### Phase 2 — simplify & decommission

- [ ] Flake cleanup on master: single prod node (keep machine name
      mom-stage-1 or rename later), delete mom-1 node, delete
      `deploy-stage`/`check-stage`/`fleet-*-stage` recipes, update
      `prod_host`.
- [ ] Watch memory/latency on the new box for ~1 week.
- [ ] Archive final mom-1 data snapshot somewhere off-box; resolve
      `/data/android`; cancel the mom-1 server.
- [ ] Update home-manager ssh config: tailscale names for the surviving
      host (mom-1 entry currently pins the public IP; it's a read-only
      home-manager symlink so must be fixed in that repo).

## Implementation Notes

- Verification checklist for cutover: `/api/health` ok; `/api/me` 401
  unauthenticated; login works; send a message in a workspace and get an
  agent turn; skills tab lists existing skills (justin's workspace has
  security-analysis + foobar); `mom serve` preview renders; `mom deploy`
  of a static site reachable at `<slug>.agentmom.xyz` with fresh TLS;
  telegram bot responds.
- Current data sizes (mom-1, 2026-07-21): app 8.9M, workspace 1.3G,
  xdg-data 4.9G, xdg-cache ~33G (regenerable). Real payload ~2G.
- mom-stage-1: 16c/62G, /data 938G (3% used), tailscale 100.73.239.5,
  public 135.181.179.143.
- Unknown: role of mom-ctrl / mom-stage-ctrl tailscale hosts — confirm
  whether either references mom-1 before cancelling.
- Both boxes' smolvm/podman versions come from the same flake pin, so any
  state that does transfer is version-compatible by construction.
