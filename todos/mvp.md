Living note. Keep this short; delete it when it stops earning its place.

# Agent Mom MVP

## Current State

MVP is effectively built.

- Vite web shell around Pi coding-agent.
- Pi JSONL sessions remain the transcript source of truth.
- Assistant UI is only the React rendering layer.
- Default runtime is one smolvm per workspace; local execution remains a smoke/dev fallback.
- Agent cwd is `<workspace>/projects`, not the app repo root.
- Preview exposure uses `mom expose`.
- Deployment publishing uses `mom deploy`.
- Auth, admin invites, per-user workspaces, Telegram links, and deployment scoping exist.
- Nix package and NixOS module exist.

## Still Worth Keeping

- `just typecheck`
- `just build`
- `just smoke-auth`
- `just smoke-local`
- `just smoke-smolvm`
- `just smoke-deploy`

## Optional Follow-Ups

- Add a live deploy smoke that checks `/api/health`, UI render, and one smolvm `bash` turn proving `/workspace`.
- Add the old Nostr prompt smoke only if it catches real regressions during dogfooding.
- Add Absurd/Postgres/resume machinery only after direct Pi sessions hurt in a specific observable way.

## Design Notes

- Do not parse prompts to decide behavior.
- Do not maintain a second durable conversation log unless Pi cannot support the UI.
- Keep display-only event history separate from agent context.
- Prefer fewer abstractions until a repeated pain point forces one.
