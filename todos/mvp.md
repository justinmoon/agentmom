Living plan. Revise it as we learn. Do not treat this as a fixed contract.

# Agent Granny 2 MVP

## Intent

Build the smallest useful Agent Granny around Pi, not beside Pi.

The first milestone is a trustworthy local coding-agent loop that can be dogfooded immediately: open a small Vite web app, use a Pi session in a real workspace, stream tool activity, resume the same session, and understand what happened when something goes wrong.

The philosophy is Grug-brained: keep the system obvious, local, and boring. Avoid clever platform machinery until the simple thing hurts in a specific way.

## Scope

[x] Use Pi coding-agent as the agent substrate.
[x] Reference local Pi at `/Users/justin/code/pi-mono`.
[x] Use assistant-ui as a light React chat rendering layer only.
[x] Reference local assistant-ui at `/Users/justin/code/assistant-ui`.
[x] Use Vite, not Next.js.
[x] Use Pi's built-in default active tools: `read`, `bash`, `edit`, `write`.
[x] Use Pi's session manager / JSONL session persistence.
[x] Use Pi's model/provider abstractions for OpenRouter.
[x] Default the workspace to the current directory; allow `AGENTGRANNY_WORKSPACE=/path` override.
[x] Build only the thin product shell Pi does not provide: local web app, API bridge, workspace display, event presentation, and dev ergonomics.
[x] Skip TUI for MVP.
[x] Keep the first runtime local and single-process.

Out of scope for the first trustworthy loop:

[ ] Custom Granny tools that duplicate Pi tools.
[ ] Custom Granny session history format.
[ ] Custom tool gating or content-specific routing.
[ ] Assistant-ui as source of truth or thread persistence.
[ ] Absurd tasks, Postgres app state, smolvm, leases, cost accounting, auth, multi-user support, deployment.

## Approach

Start by making Pi feel good through a tiny web/API wrapper.

Do not port Agent Granny 1 architecture. Port only proven setup details:

- Nix-first dev shell.
- OpenRouter key loading from this repo's local `.env`.
- Tools available by default.
- Nostr as a smoke test prompt, not runtime routing.

Use Pi's session as the source of truth. Use assistant-ui only to render chat state in React. Keep the assistant-ui adapter shallow and replaceable: convert Pi session messages/events into the minimal message shape the UI needs, and do not let assistant-ui own durable state.

The core local loop:

1. Start `agentgranny2` from a workspace, or pass `AGENTGRANNY_WORKSPACE`.
2. Create or resume a Pi session for that workspace.
3. Browser sends a user message.
4. Server forwards it to Pi.
5. Pi streams assistant text and built-in tool events.
6. Server relays events to the browser.
7. Pi persists the session.
8. Browser can reload and show the same session.

## Steps

[x] Create minimal repo skeleton: `flake.nix`, `package.json`, `tsconfig.json`, `justfile`, `src/`, `web/`, `todos/`.
[x] Wire dependencies to local Pi packages and assistant-ui packages with the smallest import surface possible.
[x] Add config: workspace path, sessions root, API port, OpenRouter model, OpenRouter env file.
[x] Create a smoke that starts a Pi session with default tools and asks a no-tool question.
[x] Create a smoke that asks Pi to read/write/edit in a temp workspace using only Pi built-ins.
[x] Build tiny API: health, list sessions, create/resume session, send message, stream events.
[x] Build Vite web app: session list, chat transcript via assistant-ui, live assistant stream, simple tool event log, current workspace header.
[x] Add visible failure states: missing key, missing workspace, Pi session load failure, model error, tool error.
[~] Dogfood against this repo: ask small questions, make small edits, verify session reload.
[ ] Add Nostr smoke as a normal prompt through Pi, with assertions on files/build output, no hardcoded routing.

## After Trustworthy Local Loop

[ ] Add process ergonomics only if Pi `bash` is insufficient for dogfooding: clearer long-running command display, stop button, output truncation policy, and process cleanup.
[ ] Add smolvm as an executor experiment behind Pi's existing tool names, starting with `bash` only. The model should still see `bash`, not a new VM-specific tool.
[ ] Add smolvm workspace mounting and command smoke.
[ ] Add smolvm web indicators only for runtime facts users need: starting, running, stopped, failed.
[ ] Add Absurd only after direct Pi sessions are reliable. First use: durable background turn execution for web requests that should survive server restart.
[ ] Add Postgres only if Absurd or multi-session metadata requires it. Keep Pi JSONL sessions as the agent transcript unless there is a concrete reason to migrate.
[ ] Add resume/recovery semantics after Absurd: a restarted server can find an interrupted session, show what completed, and avoid rerunning unsafe tool calls automatically.

## Implementation Notes

- Pi default active tools are `read`, `bash`, `edit`, `write`; do not expand this list for MVP.
- Pi has additional built-ins (`grep`, `find`, `ls`) available if we later choose a read-only or all-tools profile.
- Granny2 should not parse prompts to decide behavior.
- Granny2 should not maintain a second durable conversation log unless Pi's session API cannot support the web UI.
- If the web UI needs display-only event history that Pi does not persist, keep it explicitly separate from agent context.
- Keep assistant-ui integration deliberately thin. It is a rendering layer, not the agent runtime.
- Prefer fewer abstractions until one is forced by a test or dogfooding pain.
- Implementation uses local Pi packages via `file:/Users/justin/code/pi-mono/packages/*`.
- Implementation uses the published `@assistant-ui/react` package for runtime because `/Users/justin/code/assistant-ui` is a source checkout without package `dist` outputs; keep the checkout as the reference source.
- `src/pi-bridge.ts` is the intentional boundary: Pi owns agent state/session/tools, Granny2 owns HTTP/SSE/UI projection only.
- `.env` was copied into the repo root for local dev and ignored by git; no cross-repo env file dependency.
- Default OpenRouter model changed from `qwen/qwen3-coder-30b-a3b-instruct` to `anthropic/claude-sonnet-4.5` because Qwen sometimes emits textual `<function=write>` blocks instead of real tool calls.
- Verified with `npx agent-browser`: opened the Vite UI, submitted a no-tool prompt through the composer, saw `UI_READY` render, and captured a screenshot at `/tmp/agentgranny2-ui.png`.
- Verified server restart resumes the same Pi JSONL session and transcript from `.agentgranny2/sessions`.
- `scripts/smoke-local.ts` covers both no-tool inference and a real Pi `write` tool invocation in an isolated workspace.
