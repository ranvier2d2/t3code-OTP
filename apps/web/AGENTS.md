## What This Folder Is

- This folder contains the React/Vite web client for sessions, provider activity, and local workspace UX.
- Boundaries: UI state, rendering, browser transport, and interaction flows belong here. Provider process orchestration does not.

## Local Invariants

- Keep session UX stable under reconnects, partial history bootstrap, and streaming updates.
- UI state should reflect runtime truth from the server rather than inventing parallel protocol state.
- Preserve existing visual language unless the task explicitly asks for design changes.

## Safe Changes

- Prefer small state-machine or utility extractions when logic is duplicated across components or stores.
- Avoid embedding server-only assumptions in presentation components; keep transport adaptation near `nativeApi` and WS layers.

## Validate

- Fast check: `bun run --filter=@t3tools/web typecheck`
- Focused tests: `bun run --filter=@t3tools/web test`
