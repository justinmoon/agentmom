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

### Phase 1 — cutover (DONE 2026-07-21)

- [x] mom-1: agentmom stopped, all 13 smolvm machines stopped, service
      durably removed via `services.agentmomWeb.enable = mkForce false`
      + colmena apply (runtime `systemctl disable` is impossible on
      NixOS). Also removed a stale pre-colmena runtime unit at
      /run/systemd/system/agentmom.service (/srv/agentmom relic) that
      crash-looped once the nix unit disappeared.
- [x] Final rsync (delta ~2MB, seconds).
- [x] mom-stage-1 switched to prodHost module, telegram enabled, memory
      cap kept.
- [x] DNS flipped by user (Cloudflare, both records, DNS only).
- [x] Verified: TLS issued for agentmom.xyz after DNS propagated (first
      attempts failed while LE still saw the old IP — a caddy reload
      retried successfully); health ok; /api/me 401; correct bundle;
      bogus deploy subdomain refused a cert (on-demand TLS gate works);
      telegram polling as @agentmom_bot on the new host only.
      Pending user spot-check: login + agent turn + telegram message.

### Phase 2 — simplify & decommission

- [x] justfile: single prod host (mom-stage-1), stage recipes deleted,
      smoke-skills recipe added. Flake: mom-1 tagged old-prod with
      tailscale-IP targetHost; mom-stage-1 tagged prod.
- [x] /data/android deleted (user decision, 288G freed).
- [ ] Watch memory/latency on the new box for ~1 week
      (baseline 2026-07-21: 1.9G used / 60G available, VMs cold).
- [ ] Archive a final /data/agentmom-web snapshot off-box, then cancel
      the mom-1 server and remove its node from flake + secrets.nix.
- [ ] Update home-manager ssh config: mom-1 alias pins the public IP
      (unreachable from some networks); make sure the surviving host's
      alias uses tailscale. (Read-only symlink — fix in the home-manager
      repo.)
- [ ] After decommission: rename host/machine references if desired
      (the mom-stage-1 name is now cosmetic).

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
