# AGENTS.md

## What This Repo Is

- This repo is the T3 Code monorepo: a Bun/Turbo workspace for the desktop shell, server runtime, web client, contracts, shared utilities, and the OTP harness pilot.
- Primary boundaries live in `apps/server`, `apps/web`, `packages/contracts`, `packages/shared`, and `apps/harness`.

## Repository Expectations

- Keep changes scoped to the layer that owns the behavior. Do not push runtime logic into `packages/contracts`.
- Prefer root-cause fixes over local patches. If similar logic exists in multiple packages, extract or consolidate it.
- Preserve predictable behavior under reconnects, partial streams, session restarts, and provider failures.
- Cursor uses AcpSession (JSON-RPC 2.0 over ACP). The old CursorSession (CLI stream-json) has been removed.

## Validation Gates

- Required before completion: `bun fmt`, `bun lint`, `bun typecheck`
- Do not run `bun test`. Use `bun run test` if tests are needed at the workspace level.
- For `apps/harness`, run `mix precommit` from `apps/harness` when Elixir files change.

## Architecture Map

- `apps/server`: Node/Bun server runtime. Owns provider processes, WebSocket APIs, session orchestration, and desktop-facing backend behavior.
- `apps/web`: React/Vite frontend. Owns session UX, event rendering, local state, and browser interaction flows.
- `apps/harness`: Phoenix/OTP harness pilot. Owns provider GenServers, supervision, ports, and Elixir-side protocol adapters.
- `packages/contracts`: Shared schemas and TypeScript contracts only. No app runtime logic.
- `packages/shared`: Shared runtime helpers used by server and web through explicit subpath exports.
- `ai_docs`: planning docs, task writeups, and architecture notes. Keep these aligned with shipped behavior.

## Guardrails

- Prefer existing workspace tools and libraries. Do not add new dependencies unless the current stack cannot solve the problem cleanly.
- Keep generated output out of instruction files and repo docs unless the user asked for committed artifacts.
- When validating UI with Playwright, assume the dev stack is already running unless the user explicitly asks you to start it.
- Default local UI target for browser validation is `http://localhost:5734`.
