## What This Folder Is

- This folder contains the T3 server runtime and CLI entrypoint.
- Boundaries: provider process management, orchestration, WebSocket/native APIs, attachment handling, and desktop/backend startup live here.

## Local Invariants

- Keep provider lifecycle logic deterministic across reconnects, restarts, and partial stream failures.
- Server code is the authority for projecting provider runtime activity into orchestration/domain events.
- Cross-package shared behavior belongs in `packages/shared`; cross-package schemas belong in `packages/contracts`.

## Safe Changes

- Prefer focused changes in `src/` with integration tests for orchestration or provider behavior changes.
- Avoid pushing server-only runtime concerns into the web app or contracts package.

## Validate

- Fast check: `bun run --filter=t3 typecheck`
- Focused tests: `bun run --filter=t3 test`
