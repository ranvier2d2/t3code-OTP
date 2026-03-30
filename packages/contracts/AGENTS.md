## What This Folder Is

- This folder contains shared schemas and type contracts used across apps.
- Boundaries: schema definitions, serialization contracts, and test coverage for those contracts belong here. Runtime side effects do not.

## Local Invariants

- Keep this package schema-only. No provider process management, file IO workflows, or app-specific runtime logic.
- Backward compatibility matters here because server and web both consume these contracts.
- Prefer explicit exports and stable naming; contract churn should be intentional.

## Safe Changes

- Prefer adding tests alongside any contract change that affects wire shape or event semantics.
- Avoid importing app runtime modules into this package.

## Validate

- Fast check: `bun run --filter=@t3tools/contracts typecheck`
- Focused tests: `bun run --filter=@t3tools/contracts test`
