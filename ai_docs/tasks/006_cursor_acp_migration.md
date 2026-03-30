# 006: Migrate CursorSession from CLI stream-json to ACP JSON-RPC

**Status:** IN PROGRESS — MVP implementation landed 2026-03-30, wire capture completed same day. Implementation needs fixes (7 bugs from wire capture, see "Implementation Bugs to Fix").

## Goal

Replace the CLI `stream-json` interface in `CursorSession` with the full ACP (Agent Client Protocol) — bidirectional JSON-RPC 2.0 over stdio — while keeping OTP supervision. The GenServer shape stays the same. The protocol changes from unidirectional stdout parsing to bidirectional request-response, gaining session persistence, live mode switching, plans, todos, and user question support.

> **Wire format confirmed:** Live wire capture (2026-03-30) shows Cursor 2.6.22 uses **standard JSON-RPC 2.0** — the same framing as Codex. The existing `JsonRpc` module works directly. No custom codec needed.

## Why

Julius's ACP implementation in upstream PR #1355 is the right protocol for Cursor. Our CLI `stream-json` adapter works but is less capable:

| Capability          | CLI stream-json (current)         | ACP JSON-RPC (target)                       |
| ------------------- | --------------------------------- | ------------------------------------------- |
| Session persistence | `--resume <chatId>` CLI flag      | Native `session/load` RPC                   |
| Mode switching      | `--mode` at spawn time            | `setMode()` mid-session                     |
| Model switching     | New process per change            | `setConfigOption()` mid-session             |
| Plans/Todos         | Not supported                     | `cursor/create_plan`, `cursor/update_todos` |
| User questions      | Not supported                     | `cursor/ask_question` with multi-option UI  |
| Process lifetime    | New process per turn              | One persistent process per thread           |
| Direction           | Unidirectional (stdout → harness) | Bidirectional (JSON-RPC both ways)          |

The migration adopts the better protocol while keeping OTP's structural advantages over Effect Scopes for process supervision.

## Architecture Decision

**Option A: ACP-in-GenServer** (selected)

The GenServer replaces its stream-json parser with a JSON-RPC 2.0 codec. The protocol changes but the supervision story stays identical. This is the same pattern CodexSession already uses — Codex IS JSON-RPC 2.0 over stdio via Erlang Port.

```
DynamicSupervisor
  └── AcpSession (GenServer)            ← replaces CursorSession
        ├── Owns the Erlang Port (cursor agent --acp)
        ├── JSON-RPC 2.0 codec (bidirectional)
        │   ├── Outgoing: initialize, authenticate, session/new, session/prompt
        │   ├── Incoming responses: correlate by id via pending map
        │   ├── Incoming notifications: route by method, emit harness events
        │   └── Incoming requests: permission, elicitation → emit, await response
        ├── Extension pass-through: unknown methods forwarded to Node as raw frames
        └── OTP handles: crash restart, port cleanup, ref counting, linked children
```

### Ownership Boundary

```
Elixir (OTP) owns:                      Node (Effect-TS) owns:
─────────────────────                    ──────────────────────
Process lifecycle                        ACP Effect schemas (validation)
  Port.open → cursor agent --acp          Import from Julius's packages/effect-acp
  Port exit → cleanup + stop             Event mapping
  DynamicSupervisor placement              ACP events → ProviderRuntimeEvent
JSON-RPC 2.0 codec                       Extension method dispatch
  Request/response correlation             Plans, todos, ask_question
  Notification routing                     (commands via Phoenix channel)
  Extension pass-through                 TypeScript contracts
ACP state machine                          46 ProviderRuntimeEvent types
  initialize → authenticate →            Desktop/Electron/SQLite
  session/new → prompt → cancel
Crash isolation
  Per-process heap
  Linked crash cascading
```

### Why not Option B (ACP in Node, GenServer as supervisor only)?

The GenServer would be a thin process babysitter. Julius would rightly ask "what's different than managing a child process in Node?" The value of OTP is owning the _protocol state machine_ alongside the process tree — when the ACP process wedges mid-handshake, the GenServer's `handle_info({port, {:exit_status, _}})` + `reject_all_pending` + supervisor restart is cleaner than Effect fiber interruption propagating through the runtime.

## Template: CodexSession JSON-RPC Patterns (VERIFIED)

CodexSession already implements everything ACP needs at the transport level. All code below is from the actual codebase.

### JSON-RPC Codec (`json_rpc.ex`)

```elixir
# Encoding — 3 message types
JsonRpc.encode_request(id, method, params)       # → {"jsonrpc":"2.0","id":id,"method":...}
JsonRpc.encode_notification(method, params)       # → {"jsonrpc":"2.0","method":...}
JsonRpc.encode_response(id, result)               # → {"jsonrpc":"2.0","id":id,"result":...}

# Decoding — returns tagged tuples
JsonRpc.decode(line) →
  {:request, id, method, params}       # Incoming request FROM provider
  {:notification, method, params}      # Incoming notification
  {:response, id, result}              # Response to our request
  {:error_response, id, error}         # Error response to our request
  {:error, reason}                     # Parse failure
```

### 1. Request-Response Correlation (`codex_session.ex:1019-1036`)

```elixir
defp send_rpc_request(state, id, method, params, from \\ nil) do
  message = JsonRpc.encode_request(id, method, params)
  send_to_port(state, message)

  timer =
    if from do
      Process.send_after(self(), {:request_timeout, id}, @request_timeout)
    end

  pending = Map.put(state.pending, id, %{method: method, from: from, timer: timer})
  %{state | pending: pending}
end
```

### 2. Response Handling (`codex_session.ex:730-740`)

```elixir
defp handle_rpc_response(state, id, result) do
  case Map.pop(state.pending, id) do
    {nil, _pending} ->
      state  # Orphaned response

    {%{from: nil, method: "initialize"}, pending} ->
      # Init succeeded — send "initialized" notification, continue sequence
      state = %{state | pending: pending}
      send_to_port(state, JsonRpc.encode_notification("initialized"))
      # ... continue handshake
  end
end
```

### 3. Incoming Requests from Provider — bidirectional (`codex_session.ex:836-889`)

Two types of pending entries coexist in the same map:

```elixir
# Outgoing request awaiting response:
%{method: "turn/start", from: caller_pid, timer: timeout_ref}

# Incoming request awaiting user decision:
%{kind: :provider_request, method: "approval_request", params: %{"requestId" => ...}, from: nil, timer: nil}
```

Handler auto-approves in full-access mode or tracks for user response:

```elixir
defp handle_rpc_request(state, id, method, params) do
  request_id = Map.get(params, "requestId", "rpc-#{id}")
  runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

  if runtime_mode == "full-access" and not is_user_input?(method) do
    response = JsonRpc.encode_response(id, %{"decision" => "accept"})
    send_to_port(state, response)
    state
  else
    pending = Map.put(state.pending, id, %{
      kind: :provider_request, method: method,
      params: Map.put(params, "requestId", request_id),
      from: nil, timer: nil
    })
    %{state | pending: pending}
  end
end
```

### 4. User Response to Provider Request (`codex_session.ex:402-418`)

```elixir
def handle_call({:respond_to_approval, request_id, decision}, _from, state) do
  case find_pending_approval(state, request_id) do
    {rpc_id, _request} ->
      response = JsonRpc.encode_response(rpc_id, %{"decision" => decision})
      send_to_port(state, response)
      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id, "decision" => decision
      })
      {:reply, :ok, remove_pending(state, rpc_id)}

    nil ->
      {:reply, {:error, "Approval request not found: #{request_id}"}, state}
  end
end
```

### 5. Cleanup on Exit (`codex_session.ex:1082-1113`)

```elixir
defp reject_all_pending(state, _reason) do
  Enum.each(state.pending, fn
    {_id, %{kind: :provider_request, params: params} = entry} ->
      # Emit cancel/resolved event for tracked requests
      request_id = Map.get(params, "requestId", "unknown")
      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id, "decision" => "cancel"
      })
      if entry[:from], do: GenServer.reply(entry.from, {:error, "Session terminated"})
      if entry[:timer], do: Process.cancel_timer(entry.timer)

    {_id, %{from: from, timer: timer}} when not is_nil(from) ->
      if timer, do: Process.cancel_timer(timer)
      GenServer.reply(from, {:error, "Session terminated"})

    _ -> :ok
  end)
  %{state | pending: %{}}
end
```

### 6. Init Handshake Sequence (`codex_session.ex:196-212`)

```elixir
def handle_info(:initialize, state) do
  {id, state} = next_request_id(state)
  state = send_rpc_request(state, id, "initialize", %{
    "clientInfo" => %{"name" => "t3-harness", "version" => "0.1.0"},
    "capabilities" => %{"experimentalApi" => true}
  })
  {:noreply, state}
end
```

### 7. Port Configuration (`codex_session.ex:670-682`)

```elixir
port = Port.open(
  {:spawn_executable, to_charlist(state.binary_path)},
  [:binary, :exit_status, :use_stdio, :stderr_to_stdout,
   args: [~c"app-server"],
   line: 65_536,   # Line-based buffering, 64KB per line
   env: env]
)
```

All six patterns transfer directly to ACP. Same wire format (JSON-RPC 2.0 over stdio), same correlation mechanism (`pending` map + `Map.pop`), same bidirectional callback handling, same cleanup. Different method names.

## ACP Protocol

**Spec version:** v0.11.3, `PROTOCOL_VERSION = 1`
**Verified against:** Cursor 2.6.22 (arm64), live wire capture 2026-03-30

### CORRECTION: Wire Format IS Standard JSON-RPC 2.0

> **Previous assumption was wrong.** Julius's PR #1355 uses ndjson-rpc (`_tag`/`tag`/`payload` envelope) in his `packages/effect-acp` SDK, but the actual `cursor agent acp` binary (Cursor 2.6.22) speaks **standard JSON-RPC 2.0** — the same framing as Codex.

Live wire capture confirms:

```json
// Request (outgoing):
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}

// Response (success):
{"jsonrpc":"2.0","id":1,"result":{...}}

// Notification (no id):
{"jsonrpc":"2.0","method":"session/update","params":{...}}
```

**Impact on implementation:** We can reuse `JsonRpc.encode_request/3` and `JsonRpc.decode/1` directly. **The `AcpRpc` codec module is unnecessary.** AcpSession becomes even more like CodexSession — literally the same codec, different method names. The ndjson-rpc framing in Julius's SDK is an Effect transport layer concern, not the on-the-wire protocol.

**Spawn command:** `cursor agent acp` (NOT `cursor acp`). Args: `["agent", "acp"]`.

### ACP Method Names (VERIFIED)

**Agent Methods (Client → Agent requests, 14 total):**

| Method                      | Purpose                | Notes                                                                |
| --------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `initialize`                | Capability negotiation | Sends protocolVersion, clientCapabilities, clientInfo                |
| `authenticate`              | Auth with method ID    | `{ methodId: "cursor_login" }`                                       |
| `logout`                    | Log out                |                                                                      |
| `session/new`               | Create session         | `{ cwd, mcpServers: [] }` → returns `sessionId`                      |
| `session/load`              | Resume session         | `{ sessionId, cwd, mcpServers: [] }` → returns history               |
| `session/list`              | List sessions          |                                                                      |
| `session/fork`              | Fork session           |                                                                      |
| `session/resume`            | Resume without history |                                                                      |
| `session/close`             | Close session          | UNSTABLE                                                             |
| `session/prompt`            | Send user turn         | Params: `{sessionId, prompt: [{type,text}]}`. Returns `{stopReason}` |
| `session/cancel`            | Cancel turn            | **Notification** (not request)                                       |
| `session/set_model`         | Set model              | UNSTABLE                                                             |
| `session/set_config_option` | Set config             | Model, mode, thinking level                                          |
| `session/set_mode`          | Set mode               |                                                                      |

**Client Methods (Agent → Client, 11 total):**

| Method                         | Type         | Purpose                               |
| ------------------------------ | ------------ | ------------------------------------- |
| `session/update`               | Notification | Streaming session updates (composite) |
| `session/elicitation/complete` | Notification | URL elicitation done                  |
| `session/request_permission`   | Request      | Tool approval                         |
| `session/elicitation`          | Request      | Structured user input form            |
| `fs/read_text_file`            | Request      | Read file through client              |
| `fs/write_text_file`           | Request      | Write file through client             |
| `terminal/create`              | Request      | Create terminal                       |
| `terminal/output`              | Request      | Read terminal output                  |
| `terminal/wait_for_exit`       | Request      | Wait for exit                         |
| `terminal/kill`                | Request      | Kill terminal                         |
| `terminal/release`             | Request      | Release handle                        |

**Cursor Extension Methods (non-standard):**

| Method                | Type         | Schema                                                                                        |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `cursor/ask_question` | Request      | `{ toolCallId, title?, questions: [{ id, prompt, options: [{id, label}], allowMultiple? }] }` |
| `cursor/create_plan`  | Request      | `{ toolCallId, name?, overview?, plan, todos: [{id?, content?, title?, status?}], phases? }`  |
| `cursor/update_todos` | Notification | `{ toolCallId, todos: [...], merge: boolean }`                                                |

### Lifecycle (VERIFIED — live wire capture 2026-03-30)

```
Port.open("cursor", ["agent", "acp"])   # Spawned as: cursor agent acp
  │
  ├── Client → initialize
  │   { protocolVersion: 1,
  │     clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  │     clientInfo: { name: "t3-harness", version: "0.1.0" } }
  │   Agent ← { protocolVersion: 1,
  │              agentCapabilities: { loadSession, mcpCapabilities: {http, sse},
  │                                   promptCapabilities: {audio, embeddedContext, image} },
  │              authMethods: [{ id: "cursor_login", name, description }] }
  │
  ├── Client → authenticate
  │   { methodId: "cursor_login" }
  │   Agent ← {} (empty result = success)
  │
  ├── Client → session/new OR session/load
  │   session/new: { cwd, mcpServers: [] }
  │     → { sessionId, modes: { currentModeId, availableModes },
  │         models: { currentModelId, availableModels },
  │         configOptions: [{ id, name, description, category, type, currentValue, options }] }
  │   session/load: { sessionId, cwd, mcpServers: [] }
  │     → (same shape, load fallback: if load fails, try session/new)
  │
  │   Agent ← session/update notification (available_commands_update, pushed unsolicited after session/new)
  │
  ├── Client → session/prompt { sessionId, prompt: [{type: "text", text: "..."}] }
  │   Agent ← session/update notifications (streaming: agent_thought_chunk, agent_message_chunk, tool_call, tool_call_update)
  │   Agent ← session/request_permission requests (tool approval)
  │   Agent ← cursor/ask_question requests (user questions)
  │   Agent ← promptResult { stopReason: "end_turn" }
  │
  ├── Client → session/cancel (notification, no response)
  │
  └── Port closes → cleanup
```

### session/update Notification Types (Composite)

The `session/update` notification carries a discriminated union. The discriminant is `update.sessionUpdate` — which is **always a string** (e.g., `"agent_thought_chunk"`, `"tool_call"`), NOT an object with `_tag`. This differs from PR #1355's spec.

| Type                        | Content                                                                                                      | Verified |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `agent_thought_chunk`       | **Reasoning/thinking stream** (`content.type="text"`, `content.text`). **Not in PR #1355 spec.**             | **Wire** |
| `agent_message_chunk`       | Assistant text stream (`content.type="text"`, `content.text`)                                                | **Wire** |
| `tool_call`                 | Tool execution started (`toolCallId`, `title`, `kind`, `status:"pending"`, `rawInput`)                       | **Wire** |
| `tool_call_update`          | Tool progress/completion (`toolCallId`, `status:"in_progress"\|"completed"`, `rawOutput:{content:"..."}`)    | **Wire** |
| `available_commands_update` | Available slash commands (`availableCommands: [{name, description}]`). Pushed unsolicited after session/new. | **Wire** |
| `user_message_chunk`        | Echoed user text                                                                                             | PR #1355 |
| `plan`                      | Plan update with entries `[{content, status}]`                                                               | PR #1355 |
| `current_mode_update`       | Mode changed (`currentModeId`)                                                                               | PR #1355 |

### Key Differences from Codex JSON-RPC

> Wire format is the same (standard JSON-RPC 2.0). The differences are in method names, lifecycle, and event shape.

| Aspect           | Codex                                      | ACP (Cursor)                                                                   |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Wire format      | `{"jsonrpc":"2.0","id":id,"method":...}`   | **Same** — `{"jsonrpc":"2.0","id":id,"method":...}`                            |
| Response format  | `{"jsonrpc":"2.0","id":id,"result":...}`   | **Same**                                                                       |
| Notification     | `id` absent                                | `id` absent (same as standard JSON-RPC)                                        |
| Error shape      | `{"error":{"code":...,"message":...}}`     | **Same** — confirmed: `{"error":{"code":-32603,"message":"...","data":[...]}}` |
| Process lifetime | Long-lived (whole session)                 | Long-lived (whole session)                                                     |
| Init handshake   | `initialize` → `initialized` notification  | `initialize` → `authenticate` → `session/new`                                  |
| Turn method      | `turn/start`                               | `session/prompt`                                                               |
| Turn cancel      | `turn/cancel` (request)                    | `session/cancel` (notification)                                                |
| Events           | Granular (`turn/*`, `item/*`, `content/*`) | Composite `session/update` with discriminated union                            |
| Permission       | `approval_request` (incoming request)      | `session/request_permission` (incoming request)                                |
| Extensions       | None                                       | `cursor/*` (ask_question, create_plan, update_todos)                           |
| fs/terminal      | Not applicable                             | Agent delegates to client (`fs/read_text_file`, `terminal/create`, etc.)       |
| Models/Modes     | Via `turn/start` params                    | Rich `configOptions` with select menus from `session/new` response             |

### Session Persistence

```
if resumeSessionId:
    try session/load { sessionId, cwd, mcpServers: [] }
    on success: use resumeSessionId
    on failure: fallback to session/new
else:
    session/new { cwd, mcpServers: [] }

Resume cursor persisted as: { schemaVersion: 1, sessionId: string }
```

### Capability Negotiation (VERIFIED — live wire capture)

Agent responds to `initialize` with:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "audio": false, "embeddedContext": false, "image": true }
  },
  "authMethods": [
    {
      "id": "cursor_login",
      "name": "Cursor Login",
      "description": "Authenticate using existing Cursor login credentials."
    }
  ]
}
```

**Differences from PR #1355 spec:**

- `agentCapabilities` is flatter — `loadSession: true` instead of nested `session.load`
- `mcpCapabilities` and `promptCapabilities` are top-level under `agentCapabilities`
- `authMethods` is a top-level array, not nested under `auth.methods`
- No `fs`, `terminal`, or `sessionConfigOption` capability flags (capabilities are implicit from session/new response)

### Extension Pass-Through

When the GenServer receives a notification or request with an unrecognized method (e.g., `cursor/suggest_refactor` shipped next month), it forwards the raw frame to Node via PubSub. Node handles mapping to canonical events. The Elixir codec only needs to handle core ACP methods.

```elixir
defp handle_acp_notification(method, params, state) when method in @known_methods do
  # Handle known ACP methods internally
  ...
end

defp handle_acp_notification(method, params, state) do
  # Forward unknown extensions to Node as raw frames
  emit_event(state, :notification, "acp/extension", %{method: method, params: params})
  state
end
```

### ACP Error Codes

Standard JSON-RPC + ACP extensions:

- `-32700` Parse error, `-32600` Invalid request, `-32601` Method not found
- `-32602` Invalid params, `-32603` Internal error
- `-32800` Request cancelled (UNSTABLE)
- `-32000` Auth required, `-32001` Unauthorized, `-32002` Resource not found, `-32003` Conflict

## What ACP Eliminates from CursorSession

CursorSession has patterns that ACP makes unnecessary:

1. **Per-turn process spawning** — CursorSession spawns a new `cursor agent --print` process for every turn (`spawn_cursor_process/3`). ACP uses one persistent process per thread. This eliminates the `stopped` flag race condition pattern entirely.

2. **CLI flag juggling** — `--mode`, `--resume`, `--model`, `--output-format stream-json`, `--trust`, `--force`, `--stream-partial-output`. ACP replaces all of these with RPC methods (`session/new`, `session/load`, `setMode`, `setConfigOption`).

3. **stdin permission_response** — CursorSession writes `{"type": "permission_response", ...}` as raw JSON to stdin. ACP uses proper JSON-RPC responses to incoming requests (same pattern as CodexSession).

4. **Unidirectional event parsing** — CursorSession reads JSON lines from stdout and classifies by `type` field. ACP uses the standard `JsonRpc.decode` tagged tuples already in our codebase.

## Files to Create

- ~~`apps/harness/lib/harness/acp_rpc.ex`~~ — **NO LONGER NEEDED.** Real Cursor ACP binary uses standard JSON-RPC 2.0. Reuse existing `JsonRpc` module.
- `apps/harness/lib/harness/providers/acp_session.ex` — New GenServer implementing ProviderBehaviour via ACP (~900-1200 LOC estimated; reduced from 1100-1400 because codec is reused)

## Files to Modify

- `apps/harness/lib/harness/session_manager.ex` — Route `"cursor"` to `AcpSession` instead of `CursorSession` (1 line: `defp provider_module("cursor"), do: {:ok, AcpSession}`)
- `apps/harness/lib/harness_web/harness_channel.ex` — May need new command handlers for ACP extensions (plans, todos, ask_question) if exposed through the channel
- `apps/harness/lib/harness/providers/provider_behaviour.ex` — Possibly add optional callbacks for extension methods (or handle via generic command dispatch)

## Files to Read (Implementation References)

- `apps/harness/lib/harness/providers/codex_session.ex` — **PRIMARY TEMPLATE**. JSON-RPC 2.0 over stdio, pending map, bidirectional callbacks, cleanup patterns
- `apps/harness/lib/harness/providers/cursor_session.ex` — Current implementation to understand event mapping, permission handling, tool classification
- `apps/harness/lib/harness/json_rpc.ex` — Existing JSON-RPC codec (encode/decode)
- `apps/harness/lib/harness/providers/provider_behaviour.ex` — 9-callback contract to implement

## Files to Preserve (Do Not Delete)

- `apps/harness/lib/harness/providers/cursor_session.ex` — Keep as fallback. Remove only after AcpSession is verified E2E.

## Implementation Phases

> **Phase ordering validated by 4-provider council, then revised by live wire capture (2026-03-30).**
> Key discovery: Cursor 2.6.22 speaks **standard JSON-RPC 2.0**, not ndjson-rpc. Phase 0 (custom codec) eliminated. `JsonRpc` module reused directly.
> Recommended order: 0 (wire capture) → 1 → 2 → 3 (permissions) → 4 (persistence) → 5 → 6.

### ~~Phase 0: ACP Wire Format Codec~~ — ELIMINATED

**Real Cursor ACP binary uses standard JSON-RPC 2.0.** The existing `JsonRpc` module handles encode/decode directly. No custom codec needed. The `AcpRpc` module that was implemented is dead code and should be removed.

The ndjson-rpc framing (`_tag`/`tag`/`payload`/`Exit`) in Julius's `packages/effect-acp` SDK is an Effect transport layer concern — it wraps standard JSON-RPC for Effect's `RpcClient`/`RpcServer`. The on-the-wire protocol between `cursor agent acp` and its client is plain `{"jsonrpc":"2.0",...}`.

### Phase 0: Wire Capture (was Phase 0.5)

Capture real output from the `cursor agent acp` binary. Handshake already captured (2026-03-30). Remaining captures needed for Phase 2.

1. ~~Verify `cursor agent acp` is available~~ — **DONE.** Cursor 2.6.22, `cursor agent acp --help` works.
2. ~~Capture handshake (initialize + authenticate + session/new)~~ — **DONE.** See "Lifecycle (VERIFIED)" section above.
3. Capture remaining `session/update` variants during a real turn:
   - A turn with **reasoning/thinking** — does it appear as `agent_message_chunk` with a different content type, a separate notification method, or is it suppressed in ACP mode?
   - A turn with **tool calls** — capture full `tool_call` and `tool_call_update` payloads to verify `kind` field values and status transitions
   - A **cancelled turn** — what does `session/cancel` produce? Late notifications? Error response on prompt?
   - An **error turn** — how does ACP signal errors? Standard JSON-RPC error object? Or something else?
   - `user_message_chunk` — echoed input? Confirm whether to ignore or map.
   - **`available_commands_update`** — already captured (pushed unsolicited after session/new). Discriminant is a **string**, not an object with `_tag`. Verify if other variants also use string discriminants.
4. Save captures as golden files in `apps/harness/test/fixtures/acp/` for replay in tests
5. Document any `session/update` variants not listed in the current mapping table
6. **Verify:** At least 4 captured traces (reasoning, tools, cancel, error) available as test fixtures. Any new `session/update` discriminants documented.

#### Already captured (handshake):

```
>>> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
<<< {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{...},"authMethods":[...]}}
>>> {"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"cursor_login"}}
<<< {"jsonrpc":"2.0","id":2,"result":{}}
>>> {"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"...","mcpServers":[]}}
<<< {"jsonrpc":"2.0","id":3,"result":{"sessionId":"...","modes":{...},"models":{...},"configOptions":[...]}}
<<< {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"available_commands_update","availableCommands":[...]}}}
```

### Phase 1: Skeleton + Init Handshake + Session Bootstrap

1. Create `acp_session.ex` implementing all 9 `ProviderBehaviour` callbacks as stubs
2. Port.open with `cursor agent acp` — args `["agent", "acp"]`, use **1MB line buffer** (`line: 1_048_576`) to handle large `session/update` payloads with `rawOutput` from tool calls
3. Implement `initialize` → `authenticate` → **`session/new`** handshake using **existing `JsonRpc` codec** (standard JSON-RPC 2.0):
   - initialize: `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "t3-harness", version: "0.1.0" } }`
   - authenticate: `{ methodId: "cursor_login" }` (method ID from init response's top-level `authMethods` array)
   - **session/new: `{ cwd, mcpServers: [] }`** — store `sessionId` in state. Session isn't "ready" until this completes.
4. Parse `agentCapabilities` from init response — store in state for capability-gated features
5. `wait_for_ready/2` resolves after successful **session/new** response (not just authenticate)
6. **Stub `fs/*` and `terminal/*` client callbacks immediately.** These incoming requests can arrive on the first prompt even though we advertise capabilities as `false`. Return protocol-correct error responses:
   ```elixir
   defp handle_rpc_request(state, id, "fs/" <> _, _params) do
     send_to_port(state, JsonRpc.encode_error_response(id, -32601, "fs operations not supported"))
     state
   end
   defp handle_rpc_request(state, id, "terminal/" <> _, _params) do
     send_to_port(state, JsonRpc.encode_error_response(id, -32601, "terminal operations not supported"))
     state
   end
   ```
7. Wire into SessionManager behind config flag: `provider_module("cursor")` checks flag to route to `AcpSession` vs `CursorSession`. Do NOT replace `CursorSession` as default until MVP verified.
8. **Verify:**
   - Session starts, handshake completes, sidebar shows "Connecting → Ready"
   - Binary not found → session emits error event and stops cleanly (no crash cascade)
   - Auth failure → clear error message, no hang
   - Handshake timeout → session terminates cleanly
   - `fs/*` or `terminal/*` request during init → error response sent, no crash

### Phase 2: Turn Lifecycle

1. Implement `send_turn/2` → `session/prompt` RPC with `{ sessionId, prompt: [{type: "text", text: "..."}] }` (array of content items, NOT a string)
2. Decompose `session/update` composite notifications into harness events. **Discriminant is a string** (`update.sessionUpdate`), not an object with `_tag`:
   - **`agent_thought_chunk`** → `content/delta` with `streamKind: "reasoning_text"` + `item/started`/`item/completed` with `itemType: "reasoning"` — **VERIFIED via wire capture (separate discriminant from `agent_message_chunk`)**
   - `agent_message_chunk` → `content/delta` with `streamKind: "assistant_text"` (text streaming)
   - `tool_call` → `item/started` (tool lifecycle). Map ACP `kind` field to harness `itemType`:
     ```elixir
     defp acp_kind_to_item_type("shell"), do: "command_execution"
     defp acp_kind_to_item_type("file_edit"), do: "file_change"
     defp acp_kind_to_item_type("file_read"), do: "file_change"
     defp acp_kind_to_item_type("mcp"), do: "mcp_tool_call"
     defp acp_kind_to_item_type(unknown), do: "dynamic_tool_call"  # fallback
     ```
   - `tool_call_update` → `item/updated` (tool progress). Normalize terminal statuses to `item/completed`.
   - `plan` → plan events (if supported in harness event model)
   - `current_mode_update` → mode change event
   - `user_message_chunk` → **ignored** (echoed input, no harness event)
   - **Catch-all for unknown variants:** Any unrecognized `session/update.sessionUpdate` discriminant becomes `acp/session_update_unknown` with raw payload. Log and forward to Node. Do NOT silently drop.
3. Handle `session/prompt` response → `{ stopReason: "end_turn" }` → emit `turn/completed` (no `turnId` or `usage` in response)
4. Handle `session/prompt` **failure** response → emit `runtime/error` + `turn/completed` with status `"failed"`
5. Implement `interrupt_turn/3` → `session/cancel` (notification, not request — no response expected)
6. Handle stale notifications arriving after cancel — guard with turn state
7. **Verify:**
   - Text streaming works end-to-end
   - Reasoning renders (distinct from assistant text) — **requires Phase 0.5 data**
   - Tools show in work log with correct types
   - Sidebar "Working → Completed"
   - Cancel mid-turn → `turn/completed` with status `"interrupted"`
   - Tool call with unknown `kind` → falls back to `dynamic_tool_call`
   - Failed prompt → `runtime/error` emitted
   - Unknown `session/update` variant → logged, forwarded, not crashed
   - Empty-output turn → `turn/completed` without error

### Phase 3: Permissions + Approvals (was Phase 4)

Moved before persistence because permissions unblock real-world tool testing. Without approval handling, any tool call in non-full-access mode stalls forever.

1. Handle `session/request_permission` (incoming request from Cursor)
   - Auto-approve in full-access mode (same as CodexSession pattern)
   - Track in `pending` map in approval-required mode
2. Map to harness `request/opened` events
3. Implement `respond_to_approval/3` → `JsonRpc.encode_response(request_id, %{"decision" => decision})`
4. Handle `session/elicitation` (incoming request) → structured user input form
5. Implement `respond_to_user_input/3` → response to elicitation request
6. Pending approval cleanup on session terminate (`reject_all_pending` pattern from CodexSession)
7. **Verify:**
   - Auto-approve in full-access mode (common case, no UI prompt)
   - Manual approve/reject in approval-required mode
   - Approval flow visible in browser UI
   - Session death while approval is pending → request/resolved with "cancel"
   - User never responds → pending stays tracked (no timeout, user must act)

### Phase 4: Session Persistence (was Phase 3)

Now a policy swap on the session bootstrap from Phase 1 — conditional `session/load` with fallback instead of always `session/new`.

1. Implement `session/load` vs `session/new` based on binding state:
   - If binding has `resume_cursor_json` with `sessionId` → try `session/load` first
   - If load fails → fallback to `session/new` → overwrite binding
   - If no binding → `session/new`
2. Store `{ schemaVersion: 1, sessionId: sessionId }` in binding via `Harness.Storage`
3. Parse `configOptions` and `modes` from session response — expose for model/mode picker
4. **Verify:**
   - Multi-turn works within a single GenServer lifetime
   - Session survives GenServer restart (binding persists, session/load succeeds)
   - `session/load` failure → `session/new` fallback (clean, no error cascade)
   - Corrupt/stale binding → session/load fails → session/new succeeds → binding overwritten
   - Binding persists across BEAM restarts (SQLite)

### Phase 5: Extensions + Client Callbacks

1. Handle `cursor/ask_question` → multi-option user question UI event
2. Handle `cursor/create_plan` / `cursor/update_todos` → plan events
3. Live mode switching via `session/set_mode` RPC
4. Model switching via `session/set_config_option` RPC
5. Extension pass-through for unknown methods → `acp/extension` event to Node
6. **Verify:** Plans render, mode/model switching works without process restart, unknown extension forwarded to Node

### Phase 6: Cleanup + Cut Over

1. Remove config flag — route `"cursor"` → `AcpSession` permanently in SessionManager
2. Remove `CursorSession` (or archive to `cursor_session_legacy.ex`)
3. Update tests
4. Update task docs referencing CursorSession

### MVP Definition

**MVP = Phase 0 (wire capture) + Phase 1 + Phase 2 + Phase 3** (~65% of total effort)

A working ACP adapter that streams text, handles tools, and manages approvals. No plans, no todos, no resume across restarts, no live mode switching, no extensions. Session recovery within a GenServer lifetime works (sessionId in state); recovery across restarts requires Phase 4.

## Todo Checklist

### MVP Todos (Phases 0-3)

- [x] ~~Create `AcpRpc` codec~~ — **DEAD CODE.** Wire capture confirmed standard JSON-RPC 2.0. Remove `acp_rpc.ex` and `acp_rpc_test.exs`, use `JsonRpc` module instead.

- [x] Verify `cursor agent acp --help` locally (Cursor 2.6.22, Early Access)
- [x] Capture handshake (initialize + authenticate + session/new) — `handshake_real.ndjson`
- [x] Capture reasoning + tool call + assistant text turn — `full_turn_real.ndjson` (138 messages)
- [x] Document observed `session/update` discriminants — `agent_thought_chunk` (NEW), `available_commands_update` (NEW)
- [ ] Capture cancelled turn (session/cancel mid-prompt)
- [ ] Capture error turn (invalid prompt or provider failure)
- [ ] Replace synthetic fixtures with real wire captures
- [ ] Turn real captures into replayable golden-file tests

> 2026-03-30 update: `cursor agent acp` confirmed working on Cursor 2.6.22 (Early Access). Full handshake + turn with reasoning/tools captured. Real golden files at `apps/harness/test/fixtures/acp/handshake_real.ndjson` and `full_turn_real.ndjson`. The synthetic fixtures (`cancel_turn.ndjson`, etc.) should be replaced with real captures once cancel/error scenarios are tested.
>
> 2026-03-30 note: `AcpSession` currently appends completed turns with `turns ++ [turn]`. This is acceptable MVP debt for short sessions, but it is `O(n)` per turn for long-lived ACP sessions. If session length becomes material, switch to prepend + reverse-on-read.

- [x] Create `apps/harness/lib/harness/providers/acp_session.ex`
- [x] Add `ProviderBehaviour` callback stubs for all 9 callbacks
- [ ] Open the port with `cursor agent acp` (args `["agent", "acp"]`) and a 1MB line buffer — **current impl uses wrong args `["acp"]`**
- [x] Implement handshake sequence: `initialize` -> `authenticate` -> `session/new`
- [x] Parse and store `agentCapabilities`
- [x] Parse and store `sessionId`
- [x] Gate `wait_for_ready/2` on successful `session/new`
- [x] Add `fs/*` unsupported-request error responses
- [x] Add `terminal/*` unsupported-request error responses
- [x] Route Cursor provider behind a config flag in `session_manager.ex`
- [x] Add negative-case handling for binary missing, auth failure, and handshake timeout

- [ ] Fix `send_turn/2` — use `prompt` (array) not `message` (string) in `session/prompt` params
- [x] Track prompt requests in the pending map
- [x] Map `agent_message_chunk` to `content/delta`
- [ ] Add `agent_thought_chunk` → `content/delta` with `streamKind: "reasoning_text"` (separate clause, NOT inside `agent_message_chunk`)
- [ ] Fix `sessionUpdate` discriminant matching — match on **string** not `%{"_tag" => ...}` object
- [ ] Fix `rawOutput` extraction — it's `%{"content" => "..."}` object, not a string
- [x] Map `tool_call` to `item/started`
- [x] Map `tool_call_update` to `item/updated` / `item/completed`
- [x] Add ACP `kind` -> harness `itemType` mapping with `dynamic_tool_call` fallback
- [x] Ignore `user_message_chunk`
- [x] Forward unknown `session/update` variants as `acp/session_update_unknown`
- [x] Emit `turn/completed` on prompt success
- [x] Emit `runtime/error` and failed completion on prompt failure
- [x] Implement `interrupt_turn/3` via `session/cancel`
- [x] Guard against stale notifications after cancel
- [ ] Add turn-lifecycle tests for success, empty output, cancel, error, and unknown tool kind

- [x] Handle `session/request_permission`
- [x] Auto-approve permissions in full-access mode
- [x] Track approval-required requests in `pending`
- [x] Emit harness `request/opened` events
- [x] Implement `respond_to_approval/3`
- [x] Handle `session/elicitation`
- [x] Implement `respond_to_user_input/3`
- [x] Reject or resolve all pending provider requests on session termination
- [ ] Add approval tests for auto-approve, manual approve/reject, and pending cleanup on terminate

- [x] Run `cd apps/harness && mix test`
- [ ] Run `cd apps/harness && mix precommit`
- [x] Run `bun fmt`
- [x] Run `bun lint`
- [x] Run `bun typecheck`
- [ ] Verify config-flagged ACP adapter works end to end before cutover

### Full Todos (Phases 4-6)

- [x] Implement `session/load` bootstrap path using stored binding state
- [x] Fall back from `session/load` to `session/new`
- [x] Persist `{ schemaVersion: 1, sessionId }` via `Harness.Storage`
- [x] Overwrite corrupt or stale bindings after fallback
- [ ] Parse and expose `configOptions` and `modes`
- [ ] Add persistence tests covering restart recovery and stale binding fallback

- [ ] Handle `cursor/ask_question`
- [ ] Handle `cursor/create_plan`
- [ ] Handle `cursor/update_todos`
- [ ] Implement unknown ACP extension pass-through to Node
- [ ] Implement `session/set_mode`
- [ ] Implement `session/set_config_option`
- [ ] Add extension tests for pass-through, ask-question, plan/todo updates, and mode/config changes

- [ ] Remove the config flag and make `AcpSession` the default Cursor adapter
- [ ] Remove or archive `CursorSession`
- [ ] Update harness tests and task docs to reflect cutover
- [ ] Re-run Elixir and Bun validation after cutover

## ProviderBehaviour Callback Mapping

| Callback                  | ACP Implementation                                                 |
| ------------------------- | ------------------------------------------------------------------ |
| `start_link/1`            | GenServer.start_link, Port.open, begin init handshake              |
| `wait_for_ready/2`        | Block until `initialize` + `authenticate` + `session/new` complete |
| `send_turn/2`             | `session/prompt` RPC, track in pending map                         |
| `interrupt_turn/3`        | `session/cancel` RPC                                               |
| `respond_to_approval/3`   | JSON-RPC response to incoming permission request                   |
| `respond_to_user_input/3` | JSON-RPC response to `cursor/ask_question`                         |
| `read_thread/2`           | TBD — may need ACP `session/history` or local state                |
| `rollback_thread/3`       | TBD — verify if ACP supports rollback                              |
| `stop/1`                  | Port.close + cleanup                                               |

## GenServer State Shape

```elixir
%{
  thread_id: String.t(),
  provider: "cursor",
  port: port() | nil,
  next_id: integer(),                    # Auto-incrementing request ID (integer on wire, standard JSON-RPC 2.0)

  # ACP-specific
  acp_session_id: String.t() | nil,      # From session/new or session/load response
  agent_capabilities: map() | nil,       # From initialize response
  auth_methods: [map()] | nil,           # From initialize response, for authenticate

  # Lifecycle — session/new completion is the readiness gate
  status: :initializing | :authenticating | :creating_session | :ready | :prompting | :stopped,
  ready_waiters: [GenServer.from()],
  current_turn_id: String.t() | nil,
  stopped: boolean(),

  # Request correlation (same pattern as CodexSession)
  # Keys are integer ids (standard JSON-RPC 2.0 — matches response id directly)
  # Two types coexist:
  #   Outgoing: %{method: String.t(), from: GenServer.from() | nil, timer: reference() | nil}
  #   Incoming: %{kind: :provider_request, method: String.t(), params: map(), from: nil, timer: nil}
  pending: %{String.t() => map()},

  # Line buffer for partial ndjson lines
  buffer: String.t(),

  # Config
  event_callback: function(),
  params: map(),                         # Original start params (cwd, model, runtimeMode, etc.)
  binary_path: String.t()                # Path to cursor binary
}
```

## Risks

### Original (validated)

1. ~~**Wire format is NOT standard JSON-RPC**~~ — **RESOLVED.** Live wire capture (2026-03-30) confirms Cursor 2.6.22 uses standard JSON-RPC 2.0, not ndjson-rpc. The `JsonRpc` module works directly. The ndjson-rpc framing in Julius's SDK is an Effect transport concern, not the on-the-wire protocol.
2. ~~**CLI flag**~~ — **RESOLVED.** Real command is `cursor agent acp` (not `cursor acp`). Verified on Cursor 2.6.22. No `-e` flag visible in `--help`.
3. **ACP spec version drift** — Julius targets v0.11.3. Cursor may ship breaking changes. The extension pass-through mitigates new methods; **breaking changes to known methods are NOT mitigated** (see #11). Pin spec version in a module attribute.
4. **Authentication flow** — ACP requires `authenticate` with `{ methodId: "cursor_login" }`. The method ID comes from `initialize` response's `agentCapabilities.auth.methods[]`. If no auth methods available or auth fails, the session cannot start. Need graceful error with clear message. **Auth in headless environments** (CI, remote servers) may involve device flow or browser open — need clear error path.
5. **Composite session/update** — Unlike Codex's granular events, ACP sends one composite `session/update` notification with a discriminated union. Each variant needs decomposition into harness events. **Reasoning uses `agent_thought_chunk`** (confirmed via wire capture) — a separate discriminant NOT listed in PR #1355's spec.
6. **fs/terminal client callbacks** — ACP agent may request `fs/read_text_file`, `terminal/create`, etc. from the client. We advertise `false` for all of these in capabilities, but Cursor may still send them. **These can arrive on the first prompt** — must have error response stubs from Phase 1 (not deferred to Phase 5).
7. **No rollback in ACP** — `rollback_thread` has no ACP equivalent. The callback returns `{:error, :not_supported}`.
8. **Cursor not installed** — AcpSession must handle missing `cursor` binary (same as CursorSession today — `Port.open` raises, init returns `{:stop, reason}`).
9. **UNSTABLE methods** — `session/close`, `session/set_model`, request cancelled (`-32800`) are marked UNSTABLE in the spec. May change without notice.

### Added by council review

10. **Line buffer sizing** — Codex uses 64KB. ACP `session/update` with `rawOutput` from tool calls can be much larger. Use **1MB (`line: 1_048_576`)** matching CursorSession's precedent. If Cursor ever outputs non-ndjson debug text on stdout, it corrupts line-based decoding — add metrics for decode failure rate.
11. **Extension pass-through does NOT protect known methods** — If Cursor renames a field inside `session/update` (e.g., `agent_message_chunk` → `assistant_chunk`), our pattern matching breaks and no "unknown extension" fallback triggers. Mitigation: use **loose extraction** (`Map.get` with defaults, not strict destructuring), preserve raw frames for debugging, version-gate known methods.
12. ~~**Failure.cause heterogeneity**~~ — **RESOLVED.** Wire capture confirms standard JSON-RPC error format: `{"error":{"code":-32603,"message":"Internal error","data":[...]}}`. No Effect Cause arrays.
13. **ID type mismatch** — Live capture shows responses use **integer IDs** matching request integers (e.g., `"id":1` in, `"id":1` out). This matches standard JSON-RPC 2.0 behavior. CodexSession's `JsonRpc` module already handles this correctly. **Lower risk than originally estimated.**
14. **Long-lived process failure modes** — Moving from per-turn spawn to persistent ACP process changes the failure surface:
    - Wedged process between turns is invisible (no pending request to timeout)
    - Memory growth in Cursor subprocess (conversation context accumulates)
    - Stale notifications after `session/cancel`
    - Orphan process on brutal kill (`Process.exit(pid, :kill)`) — port closes, sends SIGHUP; verify Cursor handles it
15. **Backpressure from synchronous event_callback** — If PubSub → Channel → Node path blocks, GenServer mailbox backs up during fast streaming. Consider async dispatch or mailbox monitoring for high-throughput sessions.
16. **Concurrent prompt semantics** — Define whether one session can have multiple in-flight `session/prompt` calls. Likely single-prompt-at-a-time, but codify the invariant.
17. **Cross-language schema drift** — Julius's auto-generated Effect schemas vs our hand-written Elixir decode can diverge over time. **Golden-file tests** from Phase 0.5 wire captures are the primary mitigation.
18. **Duplicate event replay on session/load** — When resuming a session, `session/load` may replay historical events. Must not re-emit these as new harness events.

## Success Criteria

### MVP (Phases 0–3)

- [x] ~~`AcpRpc` codec~~ — **ELIMINATED.** Wire capture confirmed standard JSON-RPC 2.0. Reuse `JsonRpc` module.
- [x] Handshake wire capture (initialize + authenticate + session/new) — captured 2026-03-30
- [ ] Remaining wire captures (reasoning, tools, cancel, error turns) as golden-file test fixtures
- [ ] AcpSession implements all 9 ProviderBehaviour callbacks
- [ ] ACP init handshake (initialize + authenticate + session/new) completes — readiness gated on session creation
- [ ] `fs/*` and `terminal/*` client callbacks return protocol-correct error responses from Phase 1
- [ ] Text streaming works via session/prompt + session/update decomposition
- [ ] Reasoning renders correctly (verify discriminant from wire captures)
- [ ] Tool lifecycle (tool_call + tool_call_update → started/completed) maps correctly, unknown `kind` falls back to `dynamic_tool_call`
- [ ] Unknown `session/update` variants logged and forwarded (not silently dropped, not crashed)
- [ ] Permission auto-approve in full-access mode works
- [ ] Permission/approval flow works in browser (session/request_permission) in approval-required mode
- [ ] Pending approvals cleaned up on session terminate
- [ ] `bun fmt`, `bun lint`, `bun typecheck` pass
- [ ] Elixir tests pass (codec + session)
- [ ] Crash isolation verified: kill AcpSession, siblings unaffected
- [ ] CursorSession preserved as fallback, routing controlled by config flag

### Full (Phases 4–6)

- [ ] Session persistence across restarts (session/load with fallback to session/new)
- [ ] Corrupt/stale binding recovery (load fails → new succeeds → binding overwritten)
- [ ] Extension pass-through forwards unknown methods to Node
- [ ] cursor/ask_question renders multi-option UI
- [ ] Plans/todos render (cursor/create_plan, cursor/update_todos)
- [ ] Live mode switching via session/set_mode (no process restart)
- [ ] Model switching via session/set_config_option (no process restart)
- [ ] CursorSession removed, AcpSession is sole Cursor adapter

## LOC Estimates (revised after wire capture 2026-03-30)

| Module                    | MVP           | Full           | Notes                                                                              |
| ------------------------- | ------------- | -------------- | ---------------------------------------------------------------------------------- |
| ~~`AcpRpc` codec~~        | ~~100-120~~   | ~~100-120~~    | **ELIMINATED.** Standard JSON-RPC 2.0 — reuse existing `JsonRpc` module            |
| `AcpSession` GenServer    | 800-1000      | 1000-1300      | Reduced: codec reused. `session/update` decomposition remains the variance driver. |
| Tests (session)           | 150-250       | 250-350        | Golden-file replay from Phase 0 wire captures                                      |
| SessionManager change     | 1             | 1              | Route `"cursor"` to new module                                                     |
| Node-side (event mapping) | ~15           | ~30            | Plan event mapping in HarnessClientAdapter.ts                                      |
| **Net addition**          | **~950-1250** | **~1250-1700** | CursorSession preserved (not deleted until Phase 6)                                |

Codec elimination reduces total work by ~200-300 LOC. The implementation is now structurally identical to CodexSession: same `JsonRpc` module, same pending map pattern, different method names and event decomposition.

## Dependencies

- `cursor` binary with ACP support installed locally (verify: `cursor agent acp --help`). Confirmed working on Cursor 2.6.22 (Early Access).
- Julius's PR #1355 as implementation reference (not a code dependency)

## Upstream Reference Files (Julius's PR #1355)

Read these when implementing — they contain the protocol details we'd reimplement in Elixir:

| File                                                   | Purpose                                                        | Relevance                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/effect-acp/src/_generated/meta.gen.ts`       | Method name constants, protocol version                        | Method strings to use                                                                                          |
| `packages/effect-acp/src/protocol.ts`                  | ndjson-rpc wire protocol                                       | **Caution:** This is Effect's transport layer, NOT the on-the-wire format. Real wire is standard JSON-RPC 2.0. |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`    | Session lifecycle (spawn, init, auth, session, prompt, cancel) | Lifecycle state machine to replicate                                                                           |
| `apps/server/src/provider/acp/AcpRuntimeModel.ts`      | Parsing session/update into typed events                       | session/update decomposition logic                                                                             |
| `apps/server/src/provider/acp/CursorAcpExtension.ts`   | Cursor-specific extensions                                     | cursor/\* method schemas                                                                                       |
| `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts` | Mapping ACP events → ProviderRuntimeEvent                      | Event mapping reference                                                                                        |
| `apps/server/src/provider/Layers/CursorAdapter.ts`     | Full adapter (962 LOC)                                         | Effect Scope/Fiber patterns we replace with OTP                                                                |

## Wire Capture Findings (2026-03-30, Cursor 2.6.22)

Real `cursor agent acp` session captured with reasoning, tool call (file read), and assistant text. Golden file: `apps/harness/test/fixtures/acp/full_turn_real.ndjson` (138 messages).

### Critical corrections to PR #1355 spec

| Aspect                       | PR #1355 assumed                                       | Real wire (Cursor 2.6.22)                                                     |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Wire format                  | ndjson-rpc (`_tag`/`tag`/`payload`)                    | **Standard JSON-RPC 2.0**                                                     |
| `sessionUpdate` discriminant | Object with `_tag` field                               | **String** (`"agent_thought_chunk"`, `"tool_call"`, etc.)                     |
| Reasoning                    | `agent_message_chunk` with `content.type: "reasoning"` | **`agent_thought_chunk`** — separate discriminant                             |
| Prompt param                 | `{ sessionId, message }`                               | **`{ sessionId, prompt: [{type: "text", text: "..."}] }`** — array not string |
| Prompt response              | `{ turnId, usage }`                                    | **`{ stopReason: "end_turn" }`** — no turnId or usage                         |
| Error format                 | Effect Failure.cause array                             | **Standard JSON-RPC `{"error":{"code":...,"message":...,"data":[...]}}`**     |
| Tool status                  | `"running"` → `"completed"`                            | **`"pending"` → `"in_progress"` → `"completed"`**                             |
| Capabilities shape           | Nested (`session.load`, `auth.methods`)                | Flatter (`loadSession`, top-level `authMethods`)                              |

### Event frequency from real turn

| Discriminant                | Count | Notes                                                   |
| --------------------------- | ----- | ------------------------------------------------------- |
| `agent_thought_chunk`       | 84    | Reasoning stream — **new discriminant not in PR #1355** |
| `agent_message_chunk`       | 42    | Assistant text stream                                   |
| `tool_call_update`          | 2     | Status transitions: `in_progress` → `completed`         |
| `tool_call`                 | 1     | Initial: `kind:"read"`, `status:"pending"`              |
| `available_commands_update` | 1     | Pushed after session/new (unsolicited)                  |

### What `tool_call` and `tool_call_update` look like on the wire

```json
// tool_call (initial)
{"sessionUpdate":"tool_call","toolCallId":"call_...","title":"Read File","kind":"read","status":"pending","rawInput":{}}

// tool_call_update (in progress)
{"sessionUpdate":"tool_call_update","toolCallId":"call_...","status":"in_progress"}

// tool_call_update (completed, with output)
{"sessionUpdate":"tool_call_update","toolCallId":"call_...","status":"completed","rawOutput":{"content":"file contents..."}}
```

Note: `rawOutput` is an **object with `content` key**, not a raw string. The `content` field is the string output.

## Implementation Bugs to Fix

Identified by code review + wire capture. These must be fixed before the AcpSession implementation is usable:

### Must fix (bugs)

1. **`fail_startup/2` doesn't stop the GenServer** (`acp_session.ex:926`). It emits an error and replies to waiters, but doesn't return `{:stop, reason, state}`. After a failed initialize/authenticate/session/new, the GenServer stays alive in a broken state. Fix: callers of `fail_startup` must use its return value in a `{:stop, reason, state}` tuple.

2. **Spawn command is wrong.** Current: `{:args, [~c"acp"]}`. Correct: `{:args, [~c"agent", ~c"acp"]}`. Binary runs as `cursor agent acp`, not `cursor acp`.

3. **`AcpRpc` codec should be replaced with `JsonRpc`.** Real wire format is standard JSON-RPC 2.0. The `AcpRpc` module is dead code. All encode/decode calls should use the existing `JsonRpc` module.

4. **`session/prompt` params are wrong.** Current: `%{"sessionId" => id, "message" => text}`. Correct: `%{"sessionId" => id, "prompt" => [%{"type" => "text", "text" => text}]}`. Prompt is an array of content items, not a string.

5. **Reasoning uses `agent_thought_chunk`, not `agent_message_chunk` with `content.type: "reasoning"`.** The current `apply_session_update` pattern matches on `content.type in ["reasoning", "thinking"]` inside `agent_message_chunk`. The real discriminant is a separate `"agent_thought_chunk"` string. Need a new clause.

6. **`sessionUpdate` is a string, not an object with `_tag`.** Current `extract_session_update` extracts `update.sessionUpdate._tag`. The real shape is `update.sessionUpdate` = `"agent_thought_chunk"` (string). The decomposition pattern matching on `%{"_tag" => "agent_message_chunk"}` won't match.

7. **`tool_call.rawOutput` is an object, not a string.** Current `emit_tool_content` checks `is_binary(raw_output)`. Real shape: `%{"content" => "file contents..."}`. Need to extract `rawOutput.content`.

### Should fix (correctness)

8. **`tool_items` MapSet not cleared between turns.** `complete_turn/3` resets turn fields but leaves `tool_items` intact. Fix: add `tool_items: MapSet.new()` to `complete_turn`.

9. **`reject_all_pending/2` missing catch-all.** Add `_ -> :ok` arm for defensive completeness.

### Known debt (acceptable for MVP)

10. **`turns ++ [turn]` grows unbounded** — O(n) append on each turn. Fine for <50 turns. Fix when needed: accumulate with `[turn | state.turns]`, reverse on `read_thread`.

11. **Extension requests get `-32601` error responses.** Once Node handles extensions via channel, needs pass-through-and-wait pattern.

## Council Review Provenance

**Date:** 2026-03-30
**Councils dispatched:** 2 (architecture validation + implementation plan validation)
**Providers:** GPT-5.4 (Codex), Claude Opus 4.6 (Claude Code), Composer 2 (Cursor), GLM 5.1 (OpenCode)
**Manifests:** `/tmp/council-8da00c4c.json` (architecture), `/tmp/council-7b32970a.json` (implementation)
**Results:** `/tmp/council-8da00c4c.results.json`, `/tmp/council-7b32970a.results.json`

### Key consensus findings incorporated

1. `session/new` moved into Phase 1 (readiness gate) — all 4 models flagged this
2. Permissions (Phase 3) before persistence (Phase 4) — unblocks real-world testing
3. Phase 0.5 (wire capture) added — reasoning/thinking discriminant unknown without real traces
4. `fs/*`/`terminal/*` error stubs moved to Phase 1 — can arrive on first prompt
5. LOC estimates revised upward (1100-1500 for full AcpSession)
6. 9 new risks added (#10-#18), 3 original risks updated
7. ~~Failure.cause heterogeneity~~ — resolved: real wire uses standard JSON-RPC errors, not Effect Cause arrays
8. ~~String ID normalization~~ — resolved: real wire uses integer IDs (standard JSON-RPC 2.0)
9. Catch-all for unknown `session/update` variants (log + forward, don't drop)
10. Negative-case verification added to all phases
