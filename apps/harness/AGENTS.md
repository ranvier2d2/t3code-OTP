## What This Folder Is

- This folder contains the Phoenix/OTP harness pilot for provider supervision and protocol adapters.
- Boundaries: GenServers, DynamicSupervisors, ports, channels, storage, and Elixir-side provider behavior belong here. Shared TypeScript contracts do not.

## Local Invariants

- OTP owns process lifecycle, supervision, cleanup, and request/response correlation for provider ports.
- Protocol adapters must fail closed: reject pending work on port exit, avoid orphaned waiters, and preserve crash isolation between sessions.
- Keep provider behavior explicit. Unsupported features should return structured errors, not silent no-ops.
- Prefer `Req` for HTTP work. Do not introduce `:httpoison`, `:tesla`, or `:httpc`.

## Safe Changes

- Prefer extracting reusable protocol and session helpers when multiple providers need the same behavior.
- Keep Phoenix-specific changes limited to harness transport/UI concerns; provider runtime logic should stay in provider modules.
- Avoid generic framework boilerplate. Document only the Phoenix conventions this app actually depends on.

## Validate

- Fast check: `cd apps/harness && mix precommit`
- Focused tests: `cd apps/harness && mix test`
