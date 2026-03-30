## What This Folder Is

- This folder contains shared runtime utilities consumed by multiple apps.
- Boundaries: reusable helpers with explicit subpath exports belong here. App-specific orchestration and schemas do not.

## Local Invariants

- Preserve explicit subpath exports; do not turn this package into a barrel-style catch-all.
- Utilities here should stay broadly reusable across server and web.
- Keep dependencies light and avoid importing app-local modules.

## Safe Changes

- Prefer adding a new focused module plus explicit export entry rather than growing unrelated helpers inside an existing file.
- Avoid leaking package-internal paths into consumers.

## Validate

- Fast check: `bun run --filter=@t3tools/shared typecheck`
- Focused tests: `bun run --filter=@t3tools/shared test`
