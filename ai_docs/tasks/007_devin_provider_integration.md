# 007: Integrate Devin as a Provider

**Status:** PLANNING — API surface and repo integration points validated on 2026-03-30

## Goal

Integrate Devin as a first-class provider in T3Code-OTP using the existing server-side provider architecture in `apps/server`, without introducing a new runtime path in `apps/harness`. The implementation should let users select Devin from the existing provider/model UX, start and continue Devin-backed sessions through `ProviderService`, and surface Devin session state safely under reconnects, restarts, and partial polling windows.

> **Important:** Devin's current documented API is an org-scoped REST API built around session creation, polling, paginated message retrieval, and attachments. It is not documented as a bidirectional streaming protocol, and I did not find a documented endpoint for resolving approval or structured user-input requests programmatically. The MVP plan must respect that reduced capability surface.

## Why

T3Code-OTP already has a stable provider abstraction in the server layer:

- `ProviderKind`, `ModelSelection`, provider defaults, and capabilities in `packages/contracts`
- provider snapshots in `ProviderRegistry`
- runtime orchestration in `ProviderService`
- provider-specific session behavior in `ProviderAdapter`
- provider selection and model UX in `apps/web`

Devin fits this architecture best as another server-side provider, not as a harness-backed OTP process:

| Concern               | Existing direct providers                           | Devin fit                                                    |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Session lifecycle     | `ProviderAdapter.startSession/sendTurn/stopSession` | Maps cleanly to Devin session create/message/archive/delete  |
| Provider availability | `ServerProvider` snapshot                           | Maps to token/org config health, not CLI probing             |
| Runtime history       | canonical runtime events                            | Must be synthesized from polled session/messages APIs        |
| Attachments           | local attachment store + provider adapter upload    | Maps to Devin attachment upload API                          |
| Resume                | persisted binding + provider-specific cursor        | Maps to stored `org_id`, `devin_id`, and last message cursor |
| MCP / tool callbacks  | provider-specific                                   | No documented Devin equivalent in API v3                     |

The work is valuable because it expands T3Code-OTP's provider surface without forcing a parallel architecture. The main challenge is not wiring another provider enum; it is translating a polling-oriented external API into the repo's event-driven provider runtime model without faking unsupported interactions.

## Architecture Decision

**Option A: Direct server-side Devin adapter** (selected)

Implement Devin as a direct provider in `apps/server`, parallel to `ClaudeAdapter` and `CodexAdapter`.

```
apps/server
  └── DevinAdapter
        ├── Owns Devin REST client + auth/config validation
        ├── startSession:
        │     first turn => upload attachments (optional) + POST /v3/organizations/{org_id}/sessions
        ├── sendTurn:
        │     subsequent turns => POST /v3/organizations/{org_id}/sessions/{devin_id}/messages
        ├── poll loop:
        │     GET session + GET messages?after=cursor
        ├── maps polled data to canonical ProviderRuntimeEvent stream
        └── persists { orgId, devinId, cursor, status } in ProviderSessionDirectory
```

### Ownership Boundary

```
apps/server owns:                         apps/web owns:
──────────────────────                    ─────────────────────────────
Devin HTTP client                         Provider picker visibility
Auth + org validation                     Provider/model selection UX
Session create/send/stop                  Rendering canonical runtime events
Polling + pagination                      Unsupported-feature messaging
Attachment upload bridge                  Session status display
Canonical event synthesis                 Buffered/non-streaming UX hints
Persistence of provider binding
```

### Why not Option B: Harness-backed Devin session in OTP?

The harness pilot is for provider processes, ports, supervision trees, and protocol adapters. Devin's documented v3 API is HTTPS-based and org-scoped; there is no evidence in the provided docs that a local long-lived Devin process exists for us to supervise. Adding a harness path would split provider ownership for no technical benefit.

### Why not Option C: Browser-direct integration?

Rejected immediately. Devin uses `cog_` credentials, organization IDs, and session-management permissions. That must stay server-side.

## Current T3 Provider Architecture (VERIFIED)

### Contract and runtime boundaries

- `packages/contracts/src/orchestration.ts`
  - `ProviderKind` currently includes `codex`, `claudeAgent`, `cursor`, `opencode`
  - default provider capabilities are declared here
- `packages/contracts/src/provider.ts`
  - `ProviderSession`, `ProviderSessionStartInput`, `ProviderSendTurnInput`, `ProviderEvent`
- `packages/contracts/src/providerRuntime.ts`
  - canonical runtime event model used by the UI and orchestration layers
- `packages/contracts/src/settings.ts`
  - provider settings shape and patch schema

### Server-side integration points

- `apps/server/src/provider/Services/ProviderAdapter.ts`
  - canonical provider adapter contract
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
  - provider lookup by `ProviderKind`
- `apps/server/src/provider/Layers/ProviderService.ts`
  - adapter routing, event fanout, session recovery, runtime persistence
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts`
  - stores per-thread provider binding + resume cursor + runtime payload
- `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`
  - SQLite persistence for session bindings
- `apps/server/src/provider/Layers/CodexAdapter.ts`
  - direct provider template for runtime event synthesis
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
  - direct provider template for SDK-driven provider sessions
- `apps/server/src/provider/Layers/CodexProvider.ts`
  - provider snapshot template for binary/auth/model discovery
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
  - provider snapshot template for a non-harness provider

### Web integration points

- `apps/web/src/modelSelection.ts`
- `apps/web/src/providerModels.ts`
- `apps/web/src/store.ts`

These files assume a finite set of providers and will need Devin added explicitly.

## Devin API Surface (VERIFIED)

### Authentication and scoping

- Authentication doc: `cog_` tokens, principal + token model, service users recommended for automation
- Current API base paths are `v3/organizations/*` and `v3/enterprise/*`
- Organization-scoped session operations live under `POST/GET /v3/organizations/{org_id}/sessions...`
- Organization ID is required for org-scoped service users
- `create_as_user_id` exists, but requires `ImpersonateOrgSessions`

### Session lifecycle

- Create session:
  - `POST /v3/organizations/{org_id}/sessions`
  - body supports `prompt`, `attachment_urls`, `bypass_approval`, `playbook_id`, `knowledge_ids`, `tags`, `title`, `create_as_user_id`, and more
- Get session:
  - `GET /v3/organizations/{org_id}/sessions/{devin_id}`
  - returns `status`, `status_detail`, `structured_output`, PRs, tags, timestamps
- Send message:
  - `POST /v3/organizations/{org_id}/sessions/{devin_id}/messages`
  - documented body: `message`, optional `message_as_user_id`
- List session messages:
  - `GET /v3/organizations/{org_id}/sessions/{devin_id}/messages`
  - paginated with `first` and `after`
- Terminate session:
  - documented as `DELETE /v3/organizations/{org_id}/sessions/{devin_id}`
- Archive session:
  - documented as `POST /v3/organizations/{org_id}/sessions/{devin_id}/archive`

### Attachments

- Upload:
  - `POST /v3/organizations/{org_id}/attachments`
  - `multipart/form-data`, field `file`
  - returns `attachment_id`, `name`, `url`
- Create session accepts `attachment_urls`
- I did not find a documented attachment field on `POST .../messages`

### Polling and pagination

- Devin's own common flow recommends polling `GET session` and `GET session messages`
- Pagination uses `first` + `after`
- list responses return `items`, `has_next_page`, `end_cursor`, `total`

### Important documented status details

`GET session` documents:

- `status`: `new`, `creating`, `claimed`, `running`, `exit`, `error`, `suspended`, `resuming`
- `status_detail` while running:
  - `working`
  - `waiting_for_user`
  - `waiting_for_approval`
  - `finished`

### Critical gaps in documented API

I did **not** find documented v3 endpoints for:

- responding to `waiting_for_approval`
- resolving `waiting_for_user` as a structured request/response flow
- streaming incremental events over WebSocket/SSE
- replaying a richer provider-native event history than paginated plain messages
- changing model mid-session

These gaps drive the MVP capability downgrade.

## Recommended Capability Model

### MVP provider capabilities

Add Devin with conservative defaults:

| Capability                   | Recommended value | Rationale                                                                |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `sessionModelSwitch`         | `unsupported`     | No documented create/send-message model parameter                        |
| `supportsUserInput`          | `false`           | `waiting_for_user` is visible, but no documented response endpoint found |
| `supportsRollback`           | `false`           | No documented rollback/history rewrite API                               |
| `supportsFileChangeApproval` | `false`           | Approval state visible, response surface not found                       |
| `resume`                     | `basic`           | Existing session can be continued via `send message` + stored `devin_id` |
| `subagents`                  | `none`            | No documented subagent/session tree control needed for MVP               |
| `attachments`                | `basic`           | Upload is documented; likely only safe on first session create           |
| `replay`                     | `basic`           | Only paginated messages are documented                                   |
| `mcpConfig`                  | `none`            | No MCP config surface in docs                                            |

### Model semantics

Treat Devin as a provider with one synthetic default model in MVP, for example `devin-default`, unless later docs show a real model-selection API. This keeps the UI and settings model consistent without implying unsupported server behavior.

## UX and Operational Decisions

### Lazy remote session creation

Devin differs from the existing providers in one important way: the local T3 provider session can exist before any remote Devin session exists.

```text
T3 thread session exists
  ->
local ProviderSession = ready
  ->
first user turn
  ->
remote Devin session is created
```

This means the first remote failure may surface on the first `sendTurn`, not during `startSession`. That is acceptable, but the UI and internal state model should make the distinction explicit.

**Recommended policy**

- `startSession` creates only the local binding and validates enough config to proceed
- remote Devin session creation is deferred to the first `sendTurn`
- before first turn, Devin should be treated as "local-ready, remote-unbound"
- if first-turn remote creation fails, surface a structured provider error tied to that turn

**Why this is preferred**

- avoids creating unused remote Devin sessions for threads that never receive input
- keeps session creation aligned with a concrete user prompt
- reduces remote resource churn

### User flow for unresolvable Devin states

Devin can enter `waiting_for_approval` and `waiting_for_user`, but the documented API does not show a response surface for T3 to resolve those states directly.

**Expected user flow**

1. T3 polls Devin and observes `status_detail = waiting_for_approval` or `waiting_for_user`
2. T3 renders a warning banner or session-state notice
3. The notice includes the remote `sessionUrl`
4. The user opens the Devin web UI in the browser and resolves the state there
5. T3 continues polling
6. Once Devin returns to `working` or `finished`, T3 resumes normal rendering

**Product requirement**

The Devin UI path must never show an approval widget or structured user-input control that implies T3 can resolve the state directly. The correct UX is "state observed remotely, resolve in Devin."

## Files to Create

- `apps/server/src/provider/Services/DevinProvider.ts`
- `apps/server/src/provider/Services/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinProvider.ts`
- `apps/server/src/provider/Layers/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts`
- `apps/server/src/provider/Layers/DevinProvider.test.ts`
- `apps/server/src/provider/devinApi.ts`
  - REST helpers, endpoint wrappers, response normalization
- `apps/server/src/provider/devinApi.test.ts`
- `ai_docs/tasks/007_devin_provider_integration.md`

## Files to Modify

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/server.ts`
- `packages/contracts/src/settings.ts`
- `packages/contracts/src/providerRuntime.ts`
  - only if new raw source or event annotations are needed
- `packages/shared/src/model.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.ts`
- `apps/web/src/modelSelection.ts`
- `apps/web/src/providerModels.ts`
- `apps/web/src/store.ts`
- `apps/server/integration/providerService.integration.test.ts`

## Files to Read (Implementation References)

- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeProvider.ts`
- `apps/server/src/provider/Layers/CodexProvider.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/settings.ts`
- `apps/web/src/modelSelection.ts`
- `apps/web/src/providerModels.ts`

## Files to Preserve (Do Not Delete)

- `apps/harness/**/*`
  - Devin should not cause harness cutover or re-routing
- existing Cursor fallback paths
  - per repo instructions, keep `CursorSession` fallback paths until ACP replacements are proven

## Architecture Decision Details

### Session lifecycle mapping

| T3 provider callback | Devin mapping                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `startSession`       | Validate config and create local binding state. For first turn, create remote Devin session.                          |
| `sendTurn`           | If no remote session exists, upload attachments if needed and create session with `prompt`; else `POST .../messages`. |
| `interruptTurn`      | No documented message/turn interrupt API. MVP should return unsupported or no-op with explicit error.                 |
| `respondToRequest`   | Unsupported in MVP.                                                                                                   |
| `respondToUserInput` | Unsupported in MVP.                                                                                                   |
| `stopSession`        | Map to archive or terminate after product decision.                                                                   |
| `listSessions`       | Return active locally bound Devin sessions, not all org sessions.                                                     |
| `readThread`         | Build from locally retained turn/message snapshots if needed; otherwise unsupported initially.                        |
| `rollbackThread`     | Unsupported.                                                                                                          |

### Runtime payload shape

Persist enough state in `ProviderSessionDirectory.runtimePayload` to survive reconnects and restarts:

```ts
{
  orgId: "org-...",
  devinId: "devin-...",
  sessionUrl: "https://app.devin.ai/...",
  lastStatus: "running",
  lastStatusDetail: "working",
  lastMessageCursor: "opaque-cursor-or-null",
  createdAsUserId: null,
  usedCreateEndpoint: true,
  supportsMessageAttachments: false
}
```

### Event synthesis strategy

Devin does not expose the same runtime event granularity as Codex/Claude. The adapter will need to synthesize canonical events from:

- remote session state transitions
- newly observed paginated messages
- attachment upload completion
- local send-turn intent

That means:

- no true token streaming in MVP
- assistant output likely arrives as buffered message chunks per poll cycle
- "waiting for approval" and "waiting for user" should be surfaced as stateful warnings, not interactive request widgets

### Polling policy

Phase 3 needs an explicit polling contract so the adapter does not become an unbounded background load generator.

**Recommended initial polling policy**

| Remote state                                            | Poll interval | Notes                                               |
| ------------------------------------------------------- | ------------- | --------------------------------------------------- |
| `creating`, `claimed`, `running`, `resuming`            | `5s`          | Moderate polling while work is actively progressing |
| `waiting_for_user`, `waiting_for_approval`, `suspended` | `10s`         | Slow polling while blocked on external action       |
| `exit`, `error`                                         | stop polling  | Terminal                                            |

**Failure backoff**

- on poll failure, back off with jitter:
  - `5s -> 10s -> 15s -> 30s`
- cap failure backoff at `30s`
- reset back to the normal state-based interval when a successful poll returns
- log repeated failures and emit a `runtime.warning` before promoting to `runtime.error`

**Resource controls**

- one poll loop per active locally bound Devin session
- per-session polling state is owned by the adapter
- global adapter should cap concurrent outbound poll requests to avoid burst amplification
- message pagination should drain all available pages up to a safe per-cycle ceiling, then continue on the next cycle if more remain

**Open question to settle during implementation**

- whether Devin exposes published rate limits that require a stricter default interval than the values above

## Implementation Phases

> Recommended order: 0 → 1 → 2 → 3 → 4 → 5
>
> The early phases are contract and snapshot work so the provider is visible and selectable. The runtime adapter follows once the repo can represent Devin safely.

### Phase 0: Contracts and Provider Identity

1. Add `devin` to `ProviderKind`
2. Add Devin defaults to:
   - `DEFAULT_PROVIDER_CAPABILITIES`
   - `DEFAULT_MODEL_BY_PROVIDER`
   - `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`
   - `PROVIDER_DISPLAY_NAMES`
3. Add Devin settings schema to `packages/contracts/src/settings.ts`
   - recommend `enabled`, `orgId`, `baseUrl`, `customModels`
   - do **not** persist the API token in repo-managed JSON by default
4. Update server and web codepaths that assume four providers
5. Add tests covering schema decode/defaults
6. **Verify:**
   - contracts compile
   - web/provider model helpers accept `devin`
   - settings defaults decode cleanly

### Phase 1: Provider Snapshot and Config Validation

1. Implement `DevinProvider` snapshot service
2. Resolve config from:
   - server settings for `enabled`, `orgId`, `baseUrl`, custom models
   - environment or secret source for API token
3. Validate auth using `GET /v3/self`
4. Validate org access against configured `orgId`
5. Expose a `ServerProvider` snapshot:
   - `installed: true` when config exists and auth works
   - `authStatus` from HTTP result
   - `status` / `message` reflecting config or permission failures
   - models list containing built-in synthetic Devin model + custom models
6. Register `DevinProvider` in `ProviderRegistry`
7. **Verify:**
   - disabled config yields disabled snapshot
   - missing token yields unauthenticated/error snapshot
   - bad org id yields warning/error with actionable message
   - valid config shows Devin in `server.providersUpdated`

### Phase 2: REST Client and Session Bootstrap

1. Create `devinApi.ts` for:
   - `getSelf`
   - `createAttachment`
   - `createSession`
   - `getSession`
   - `listSessionMessages`
   - `sendSessionMessage`
   - `archiveSession`
   - `terminateSession`
2. Normalize Devin timestamps/status fields into a small internal DTO layer
3. Implement `DevinAdapter.startSession`
   - bind thread locally
   - no remote session yet, unless architecture prefers eager creation
4. Implement first-turn `sendTurn`
   - optionally upload local attachments and collect returned `url`s
   - create remote Devin session with `prompt`
   - persist `{ orgId, devinId, cursor }`
5. Add provider adapter registration
6. **Verify:**
   - first turn creates remote session
   - session id persists in runtime binding
   - attachment upload failure is surfaced cleanly
   - no duplicate remote session on retry with existing binding

### Phase 3: Polling, Message Cursor, and Canonical Events

1. Implement a polling loop per active Devin session
2. Poll:
   - `GET session`
   - `GET messages?after=<cursor>`
3. Apply the state-based polling policy:
   - `5s` while actively working or transitioning
   - `10s` while blocked on user/approval/suspension
   - stop on terminal state
4. Apply failure backoff with jitter and a `30s` cap
5. Store latest cursor from `end_cursor`
6. Deduplicate newly seen messages using cursor and/or event/message IDs
7. Map data into canonical runtime events:
   - local first-turn create => `session.started`, `thread.started`, `turn.started`
   - new assistant text => `item.started`, `content.delta`, `item.completed`
   - remote terminal status => `session.state.changed`, `turn.completed`, `runtime.warning`
8. Map `status_detail`:
   - `working` => running
   - `finished` => completed/ready
   - `waiting_for_user` => waiting + warning + open-in-Devin UX
   - `waiting_for_approval` => waiting + warning + open-in-Devin UX
9. Add reconnect-safe recovery from persisted binding and cursor
10. Add a safety ceiling for per-cycle pagination drain and global poll concurrency
11. **Verify:**

- paginated messages are not replayed repeatedly
- session restarts continue polling from stored state
- buffered assistant output renders in the UI
- waiting states are visible and non-broken
- open-in-Devin user flow is explicit when T3 cannot resolve the state
- repeated poll failures back off instead of hot-looping

### Phase 4: Follow-up Turns and Stop Semantics

1. Implement subsequent `sendTurn` via `POST .../messages`
2. Decide attachment policy:
   - safest MVP: attachments only on initial session create
   - if later verified, allow per-message attachments
3. Implement `stopSession`
   - choose archive vs terminate
   - document the choice in code and task notes
4. Make unsupported operations explicit:
   - `interruptTurn`
   - `respondToRequest`
   - `respondToUserInput`
   - `rollbackConversation`
5. **Verify:**
   - second and third turns append to the same Devin session
   - stop cleans local binding and remote state consistently
   - unsupported methods fail with structured provider errors

### Phase 5: UX Hardening, Advanced Features, and Documentation

1. Add explicit UI copy for Devin limitations:
   - non-streaming/buffered behavior
   - approval/user-input unsupported through T3 API path
   - model switch unsupported
2. Consider optional advanced follow-ons:
   - `create_as_user_id`
   - playbook/session tags
   - knowledge IDs / repo links
   - structured output schema
3. Add operator notes to `ai_docs/provider_onboarding.md` if needed
4. Remove any temporary feature flag if confidence is sufficient
5. **Verify:**
   - no broken approval controls appear for Devin
   - docs reflect the actual shipped capability set

## MVP Definition

**MVP = Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 core send/stop flow**

That yields:

- Devin selectable in provider UI
- auth/config health visible in provider snapshots
- first turn creates a Devin session
- follow-up turns append via message API
- session state and messages appear in T3 via polling
- unsupported interactions fail explicitly instead of hanging

Not included in MVP:

- interactive approval resolution
- structured user-input resolution
- interrupt/cancel semantics unless docs prove a real endpoint
- model switching
- rollback
- MCP integration
- rich tool lifecycle parity with Codex/Claude

## Todo Checklist

### MVP Todos

- [ ] Add `devin` to `ProviderKind`
- [ ] Add Devin default capabilities
- [ ] Add Devin model defaults and display name
- [ ] Add Devin settings schema and patch schema
- [ ] Update web/provider helpers for a fifth provider
- [ ] Add contract tests for Devin defaults

- [ ] Create `apps/server/src/provider/devinApi.ts`
- [ ] Implement `getSelf`
- [ ] Implement `createAttachment`
- [ ] Implement `createSession`
- [ ] Implement `getSession`
- [ ] Implement `listSessionMessages`
- [ ] Implement `sendSessionMessage`
- [ ] Implement `archiveSession`
- [ ] Implement `terminateSession`
- [ ] Add REST client tests for auth, pagination, and error normalization

- [ ] Create `DevinProvider` service and live layer
- [ ] Validate token with `/v3/self`
- [ ] Validate configured `orgId`
- [ ] Expose snapshot message for missing token / missing org / bad permissions
- [ ] Register `DevinProvider` in `ProviderRegistry`

- [ ] Create `DevinAdapter` service and live layer
- [ ] Register `DevinAdapter` in `ProviderAdapterRegistry`
- [ ] Persist Devin runtime binding payload with `orgId`, `devinId`, and message cursor
- [ ] Implement first-turn session creation
- [ ] Implement optional first-turn attachment upload path
- [ ] Implement polling loop for session status and messages
- [ ] Implement message pagination with `first` and `after`
- [ ] Deduplicate paginated messages across polling cycles
- [ ] Map remote status and messages into canonical runtime events
- [ ] Implement follow-up turn delivery through `POST .../messages`
- [ ] Implement stop semantics through archive or terminate
- [ ] Return structured unsupported errors for approval, user input, rollback, and interrupt

- [ ] Add server integration tests for first turn, multi-turn, polling, reconnect, and stop
- [ ] Add web tests for provider selection and fallback behavior if needed
- [ ] Run `bun fmt`
- [ ] Run `bun lint`
- [ ] Run `bun typecheck`

### Full Todos

- [ ] Decide whether to support `create_as_user_id`
- [ ] Decide whether to expose tags/playbooks/knowledge IDs in project or thread settings
- [ ] Verify whether Devin supports per-message attachments beyond session create
- [ ] Add richer runtime event synthesis if Devin exposes more detailed message metadata
- [ ] Add optional feature flag if rollout should be staged
- [ ] Extend onboarding docs and operator runbooks

## ProviderAdapter Callback Mapping

| Callback             | Devin implementation                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `startSession`       | Create local adapter session state and persisted binding                         |
| `sendTurn`           | Create remote session on first turn, then send follow-up messages                |
| `interruptTurn`      | Unsupported in MVP unless a documented endpoint is found                         |
| `respondToRequest`   | Unsupported in MVP                                                               |
| `respondToUserInput` | Unsupported in MVP                                                               |
| `stopSession`        | Archive or terminate remote session, then clear local binding                    |
| `listSessions`       | Return locally active Devin-backed thread sessions                               |
| `readThread`         | Optional local reconstruction from polled messages; may remain limited initially |
| `rollbackThread`     | Unsupported in MVP                                                               |
| `stopAll`            | Stop all locally tracked Devin sessions                                          |

## Risks

1. **No documented approval-response API**
   - The docs expose `waiting_for_approval` but I did not find a response endpoint. We must not expose false approval support.

2. **No documented structured-user-input response API**
   - Same issue for `waiting_for_user`.

3. **No documented streaming transport**
   - The adapter must synthesize runtime events from polling. This will feel different from Codex/Claude.

4. **Send-message attachment uncertainty**
   - Create session accepts `attachment_urls`; send-message docs do not. MVP should assume first-turn-only attachments until proven otherwise.

5. **Model semantics may be synthetic**
   - If Devin does not expose user-selectable models via API, the provider model concept is mostly a T3 UI compatibility shim.

6. **Polling duplication and reconnect drift**
   - Cursor-based pagination reduces replay risk, but incorrect cursor persistence will duplicate assistant output or miss messages.

7. **Stop semantics are product-significant**
   - Archive and terminate are not the same. The adapter must choose deliberately and document the tradeoff.

8. **Token handling**
   - Storing `cog_` tokens in persistent server settings would be a bad default. Prefer env or secret injection.

9. **Permission scoping**
   - `ManageOrgSessions`, `ViewOrgSessions`, `UseDevinSessions`, and maybe `ImpersonateOrgSessions` all matter. A partially permissioned service user can fail in non-obvious ways.

10. **Capability mismatch with current UI**

- Existing T3 UX expects richer provider interactions. Devin must degrade explicitly rather than silently.

11. **Polling load and rate budgeting**

- One poll loop per active session can turn into avoidable API pressure without explicit interval, backoff, jitter, and concurrency caps.

12. **Lazy-create UX divergence**

- Devin remote sessions are created on first turn, not necessarily on `startSession`. That changes when failures surface and must be visible in product behavior.

## Success Criteria

### MVP

- [ ] `devin` exists in contracts, settings, provider defaults, and web selectors
- [ ] Provider snapshot shows actionable auth/config state for Devin
- [ ] First Devin turn creates a real remote Devin session
- [ ] Follow-up turns append to the same remote session
- [ ] Polling retrieves new messages without duplicate replay
- [ ] Session state in T3 reflects remote Devin `status` and `status_detail`
- [ ] Polling cadence, backoff, and stop conditions are explicit and implemented
- [ ] Waiting states include an open-in-Devin user path
- [ ] Unsupported approval/user-input flows surface clear warnings or structured errors
- [ ] `bun fmt`, `bun lint`, and `bun typecheck` pass

### Full

- [ ] Devin rollout docs exist
- [ ] Stop/archive semantics are settled and tested
- [ ] Optional advanced session metadata is exposed only if validated
- [ ] Provider limitations are explicit in UI and docs

## Validation Gates

- `bun fmt`
- `bun lint`
- `bun typecheck`

Do not run `bun test`. If workspace tests are needed, use `bun run test`.

## Dependencies

- Devin service-user API key (`cog_...`)
- Devin organization ID (`org-...`)
- service user permissions sufficient for session management
- a clear token source for local/dev/prod environments

## LOC Estimates

| Module                                 | MVP           | Full          | Notes                                                                               |
| -------------------------------------- | ------------- | ------------- | ----------------------------------------------------------------------------------- |
| `apps/server/src/provider/devinApi.ts` | 200-300       | 220-320       | REST client + DTO normalization for 8-ish endpoints                                 |
| `DevinProvider` service + layer        | 150-200       | 170-220       | Config resolution, `/v3/self`, org validation, snapshot mapping                     |
| `DevinAdapter` service + layer         | 400-600       | 550-750       | Polling loop, cursor persistence, canonical event synthesis are the variance driver |
| Contract + web/provider wiring         | 50-100        | 80-140        | `ProviderKind`, defaults, settings, model helpers, UI selectors                     |
| Tests                                  | 300-400       | 400-550       | REST client, provider snapshot, adapter flow, integration coverage                  |
| **Net addition**                       | **1100-1600** | **1420-1980** | Conservative TypeScript-heavy estimate                                              |

## Source Notes

Verified against these docs on 2026-03-30:

- Authentication: https://docs.devin.ai/api-reference/authentication
- Common Flows: https://docs.devin.ai/api-reference/common-flows
- Pagination: https://docs.devin.ai/api-reference/concepts/pagination
- Create Session: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- Get Session: https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
- List session messages: https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
- Send a message to a session: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
- Upload an attachment: https://docs.devin.ai/api-reference/v3/attachments/post-organizations-attachments

Repo references used for planning:

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/settings.ts`
- `packages/contracts/src/model.ts`
- `packages/shared/src/model.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/web/src/modelSelection.ts`
- `apps/web/src/providerModels.ts`
- `apps/web/src/store.ts`
