Living plan. Revise it as we learn. Do not treat this as a fixed contract.

# Everything on Fly: server + deployments

## Intent

Get agentmom entirely off Hetzner. The server becomes a Fly app; user
deployments become Fly apps (no podman anywhere — the app server executes
zero user code). mom-stage-1 is freed for the user's personal microvm.nix
plans. Budget target: ~$50/month total (user sets a billing alert; our
side enforces quotas + tiny machines).

## Data safety

- Local archive taken 2026-07-22 BEFORE any changes:
  ~/agentmom-backup/mom-stage-1/ (34MB; catalog 13 users/13 workspaces,
  sessions, skills, deployment records; node_modules excluded as
  regenerable). mom-1 copy skipped — stale pre-cutover duplicate.
- Sandboxes' source of truth is already Fly volumes (untouched by this).

## Architecture

- Server: Fly app `agentmom-web`, region arn, one machine
  (shared-cpu-2x/2048MB — tar sync buffers need headroom), volume
  `data` (20GB) at /data. AGENTMOM_STATE_DIR=/data/app,
  AGENTMOM_WORKSPACE=/data/workspace. Always-on (it is the control
  plane + telegram long-poller): autostop off. Dockerfile (node:24 +
  flyctl binary) + fly.toml in repo; deploy via `fly deploy`.
- Secrets via `fly secrets`: OPENROUTER_API_KEY, BRAVE_API_KEY,
  AGENTMOM_TELEGRAM_BOT_TOKEN, AGENTMOM_FLY_API_TOKEN (org token, used
  to manage am-ws-*/am-dep-* child apps). agenix/nix module retire
  after cutover.
- TLS/routing: agentmom.xyz + *.agentmom.xyz A/AAAA -> the server
  app's Fly IPs (shared v4 + dedicated v6). App cert for agentmom.xyz
  added once; per-deployment certs (slug.agentmom.xyz) added via Fly
  API at publish time (http-01 through the wildcard A record - no
  wildcard cert, no DNS-01, fully automatable). Caddy retires; Fly
  edge terminates TLS.
- Deployments v2 (#3): container deploys -> Fly app `am-dep-<slug>`
  via `flyctl deploy --remote-only` from the freshly pulled mirror
  dir, generated fly.toml (internal_port from --port, $PORT env,
  shared-cpu-1x/256MB, autostop=stop min_machines=0, http service).
  DeploymentManager.fetch proxies to https://am-dep-<slug>.fly.dev.
  Old image prune on redeploy. Static deploys unchanged (files on the
  server volume, zero execution). Quota stays 5/workspace. Suspend/
  wake/port-reservation machinery for container deploys DELETED (Fly
  autostop replaces it).
- Cost guardrails: quota 5/workspace; deploy machines shared-1x/256MB
  (flat ~$2/mo ceiling each even if pegged); sandbox reaper unchanged;
  deployments rely on Fly-native autostop. USER ACTION: set $50
  billing alert (or prepaid credits) in the Fly dashboard - no API for
  this.

## Cutover sequence

1. Build server image, create agentmom-web app + volume, set secrets
   (AGENTMOM_TELEGRAM_DISABLED=1 initially).
2. Seed /data volume from a fresh rsync snapshot; start on fly.dev
   hostname; verify health/auth/state with real catalog.
3. Test a real agent turn + deployment v2 end to end from the Fly
   server (staging-style, via fly.dev hostname).
4. Cutover: stop agentmom on mom-stage-1; final data snapshot -> push
   to volume; unset TELEGRAM_DISABLED; user flips DNS (agentmom.xyz +
   wildcard -> Fly IPs); verify checklist; fly certs for agentmom.xyz.
5. After stable: strip nix fleet machinery from the repo (module,
   hosts, colmena, agenix, justfile fleet recipes) - the repo keeps
   only dev shell + Dockerfile. mom-stage-1 is then free to wipe.

## Steps (cutover complete 2026-07-22)

- [x] Dockerfile + fly.toml; flyctl in image
- [x] Deployments v2 shipped and E2E'd live (remote build, proxy,
      autostop, removal). Static path + quota preserved.
- [x] agentmom-web provisioned, seeded (final quiesced snapshot,
      13 users), verified on fly.dev then on agentmom.xyz post-DNS
      (TLS issued after AAAA records — Fly requires AAAA or ownership
      TXT with shared v4; cert edge propagation takes ~2 min).
- [x] Telegram live from Fly. Old server stopped (rollback: point DNS
      back + systemctl start agentmom, until the box is wiped).
- [x] Repo cleanup: nix reduced to a dev shell (flyctl replaces
      colmena/agenix/podman); justfile deploy-prod = fly deploy.
      nix/secrets kept as encrypted token backup.
- [ ] User spot check: login + agent turn + telegram message
- [ ] User: $50 billing alert in Fly dashboard (no API for this)
- [ ] After spot check passes: all-clear to wipe mom-stage-1

## Implementation Notes

- config.ts is already fully env-driven; requireServiceSecrets checks
  values, not the env file - fly secrets work directly.
- Shim bootstrap URL (agentmom.xyz/api/sandbox-shim) survives cutover;
  both old and new servers serve identical shim during the window.
- Telegram singleton: keep AGENTMOM_TELEGRAM_DISABLED=1 on Fly until
  mom-stage-1's service is stopped.
