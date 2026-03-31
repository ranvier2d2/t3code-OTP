defmodule Harness.Dev.Explain do
  @moduledoc """
  Topic registry and renderer for developer-facing explanations of harness internals.

  Hybrid source model:
  - Provider-specific topics (startup, resume-fallback) are source-backed
    from @explain_sections metadata on provider modules.
  - Bridge contract is backed by Harness.Dev.BridgeContract.
  - Higher-level topics (providers, wal, approval-flow, subagents, model-discovery)
    are centralized here.
  """

  alias Harness.Dev.BridgeContract

  # --- Centralized topics (not owned by a single provider module) ---

  @centralized_topics %{
    "providers" => %{
      title: "Provider Comparison",
      content: """
      | Provider | Transport | Lifecycle | Binary | Auth Model |
      |----------|-----------|-----------|--------|------------|
      | Codex | stdio JSON-RPC 2.0 (Erlang Port) | Long-lived process, multiple turns | `codex app-server` | API key or ChatGPT account |
      | Claude | stdout stream-json (Erlang Port) | New process per turn | `claude --output-format=stream-json` | API key (via claude binary) |
      | Cursor | stdout stream-json (Erlang Port) | New process per turn | `cursor agent --print --output-format stream-json` | Cursor account (via binary) |
      | OpenCode | HTTP REST + SSE | Long-lived HTTP server | `opencode serve --port PORT` | Configurable per-provider |

      **Key differences:**
      - Codex and OpenCode are long-lived: one process handles multiple turns.
      - Claude spawns a new process per turn.
      - Codex and Cursor (ACP) use bidirectional stdio (JSON-RPC request/response).
      - Claude uses unidirectional stdout (stream of JSON events).
      - OpenCode uses HTTP POST for commands and SSE for event streaming.
      """,
      related_topics: ["startup", "bridge-contract"],
      related_files: [
        "apps/harness/lib/harness/providers/codex_session.ex",
        "apps/harness/lib/harness/providers/claude_session.ex",
        "apps/harness/lib/harness/providers/acp_session.ex",
        "apps/harness/lib/harness/providers/opencode_session.ex"
      ]
    },
    "wal" => %{
      title: "Write-Ahead Log (WAL) Ring Buffer",
      content: """
      The SnapshotServer maintains an in-memory ring buffer of the last 500 events
      for reconnection recovery.

      **Mechanics:**
      1. Each event gets a monotonic sequence number (starts at 0, increments by 1).
      2. Events are appended to a `:queue` ring buffer.
      3. When the buffer exceeds 500 entries, the oldest is evicted.
      4. `replay_since(after_seq)` returns all events with seq > after_seq.
      5. If after_seq is too old (evicted), returns `{:gap, current_seq, oldest_seq}`.

      **Reconnection flow:**
      - Node tracks `lastSeenSeq` for each received event.
      - On WebSocket reconnect, Node sends `events.replay` with `afterSeq`.
      - If replay succeeds: missed events are re-delivered in order.
      - If gap: Node must full-resync via `snapshot.get`.

      **Limitations:**
      - In-memory only — events lost on BEAM restart.
      - 500-event window may be too small under high throughput.
      - No persistence to disk (by design — fast path only).
      """,
      related_topics: ["bridge-contract"],
      related_files: ["apps/harness/lib/harness/snapshot_server.ex"]
    },
    "approval-flow" => %{
      title: "Approval Request Flow",
      content: """
      When a provider needs permission to execute a tool (file write, command execution),
      the approval request flows through the full stack:

      1. **Provider → GenServer**: Provider emits a request notification
         (e.g., `item/commandExecution/requestApproval` for Codex,
         or stream-json `tool_use` for Claude/Cursor).
      2. **GenServer → SnapshotServer**: Event emitted with `kind: :request`.
         Snapshot tracks it in `session.pending_requests`.
      3. **SnapshotServer → PubSub → Channel → Node**: Pushed as `harness.event`
         with the request payload.
      4. **Node → HarnessClientAdapter**: Maps to `request.opened` runtime event.
      5. **Node → UI**: Orchestration engine presents approval prompt.
      6. **UI → Node → Channel → GenServer**: User decision sent via
         `session.respondToApproval` with `requestId` and `decision`.
      7. **GenServer → Provider**: Decision forwarded to the provider process.
      8. **GenServer → SnapshotServer**: Emits `request/resolved` event.
         Snapshot removes from `pending_requests`.

      **Timeout behavior:** Codex has a 20s RPC timeout. Claude/Cursor approvals
      have no timeout (process waits indefinitely for user response).
      """,
      related_topics: ["bridge-contract", "providers"],
      related_files: [
        "apps/harness/lib/harness/providers/codex_session.ex",
        "apps/harness/lib/harness_web/harness_channel.ex"
      ]
    },
    "subagents" => %{
      title: "Subagent and Collaboration Support",
      content: """
      Two providers support subagent/collaboration patterns:

      **Codex — Collaboration Mode:**
      - Codex supports `collaborationMode` with plan mode and default mode.
      - Plan mode sends developer instructions that restrict the agent to non-mutating exploration.
      - Collab agents create child threads (receiver threads).
      - `collabAgentToolCall` items contain `receiverThreadIds`.
      - 13 notification types from child threads are suppressed to prevent duplicate UI state:
        thread/started, thread/status/changed, thread/archived, thread/unarchived,
        thread/closed, thread/compacted, thread/name/updated, thread/tokenUsage/updated,
        turn/started, turn/completed, turn/aborted, turn/plan/updated, item/plan/delta.
      - Tracked in GenServer state as `collab_receiver_turns` map.

      **OpenCode — Subtask Agents:**
      - Primary agents (Build, Plan) delegate to subagents (General, Explore, custom).
      - Child sessions created via `session.created` SSE event with `parentID`.
      - Part types: `subtask`, `agent`, `step-start`/`step-finish`.
      - Mapped to `collab_agent_spawn_begin` events on the Node side.
      """,
      related_topics: ["providers", "bridge-contract"],
      related_files: [
        "apps/harness/lib/harness/providers/codex_session.ex",
        "apps/harness/lib/harness/providers/opencode_session.ex"
      ]
    },
    "model-discovery" => %{
      title: "Model Discovery and Caching",
      content: """
      The harness discovers available models from provider CLIs and caches them in ETS.

      **Supported providers:**
      - **Cursor**: `cursor agent --list-models` — parses newline-separated model slugs.
      - **OpenCode**: `opencode models` — parses tabular output with model name and provider columns.

      **Caching:**
      - Results cached in ETS table with 10-minute TTL.
      - `list_models/1` returns cached results, fetches if missing or expired.
      - `refresh/1` forces a fresh fetch regardless of cache.

      **Codex and Claude:** Model lists are hardcoded on the Node side
      (in `@t3tools/shared/model`), not discovered from CLI.
      The harness only discovers for Cursor and OpenCode.
      """,
      related_topics: ["providers"],
      related_files: ["apps/harness/lib/harness/model_discovery.ex"]
    },
    "startup" => %{
      title: "Codex Session Startup Sequence",
      content: """
      When a Codex session starts, the following sequence executes:

      1. **SessionManager.start_session(params)** validates `threadId` and `provider`,
         then starts a child GenServer under DynamicSupervisor.

      2. **CodexSession.init/1** resolves the binary path:
         - `providerOptions.codex.binaryPath` (from params)
         - `System.find_executable("codex")` (PATH lookup)
         - Falls back to `"codex"` literal.

      3. **Version check**: Runs `codex --version` via `System.cmd/3` (4s timeout).
         Parses semver, requires minimum v0.37.0.
         Rejects versions with prerelease tags as older than release.

      4. **Spawn**: Opens `codex app-server` via `Erlang Port` (`:spawn_executable`).
         Passes `CODEX_HOME` env var if `providerOptions.codex.homePath` is set.

      5. **Initialize**: Sends JSON-RPC `initialize` request, then `initialized` notification.

      6. **Account read**: Sends `account/read` RPC to determine:
         - Account type: `apiKey` or `chatgpt`
         - Plan type: `free`, `go`, `plus`, `pro`, `team`, `enterprise`
         - Spark eligibility: disabled for free/go/plus plans.
         If spark model requested but not eligible, downgrades to `gpt-5.3-codex`.

      7. **Thread start**: Sends `thread/start` or `thread/resume` based on `resumeCursor` param.

      8. **Ready**: Sets `ready: true`, replies to all `ready_waiters`.
         SessionManager returns `{:ok, %{threadId, provider, status: "ready"}}`.

      **Total timeout**: 60 seconds (set in SessionManager).
      """,
      related_topics: ["resume-fallback", "providers"],
      related_files: [
        "apps/harness/lib/harness/session_manager.ex",
        "apps/harness/lib/harness/providers/codex_session.ex"
      ]
    },
    "resume-fallback" => %{
      title: "Thread Resume Fallback",
      content: """
      When a session starts with a `resumeCursor`, CodexSession sends `thread/resume`
      instead of `thread/start`. If resume fails with a recoverable error, it
      automatically falls back to `thread/start`.

      **Recoverable error detection:**
      The error message (lowercased) is checked against these snippets:
      - "not found"
      - "missing thread"
      - "no such thread"
      - "unknown thread"
      - "does not exist"

      **Behavior:**
      1. `thread/resume` sent with the resume cursor.
      2. If RPC response is an error AND the message matches a recoverable snippet:
         - Log warning: "Thread resume failed (recoverable), falling back to thread/start"
         - Send `thread/start` with fresh thread overrides.
      3. If non-recoverable error: propagate failure, reply error to `ready_waiters`.

      **Why this exists:** Thread IDs can become stale (deleted, compacted, or from a
      different Codex app-server instance). Rather than failing the entire session start,
      we gracefully fall back to a new thread.
      """,
      related_topics: ["startup"],
      related_files: ["apps/harness/lib/harness/providers/codex_session.ex"]
    }
  }

  @all_topic_slugs Map.keys(@centralized_topics) ++ ["bridge-contract"]

  @doc """
  List all available explain topics.
  """
  def topics do
    centralized =
      Enum.map(@centralized_topics, fn {slug, topic} ->
        %{slug: slug, title: topic.title}
      end)

    bridge = [%{slug: "bridge-contract", title: "Node ↔ Elixir Bridge Contract"}]

    (centralized ++ bridge)
    |> Enum.sort_by(& &1.slug)
  end

  @doc """
  Render a single explain topic.
  """
  def topic("bridge-contract") do
    contract = BridgeContract.contract()

    {:ok,
     %{
       topic: "bridge-contract",
       title: contract.title,
       content: contract,
       related_topics: ["providers", "wal"],
       related_files: [
         "apps/harness/lib/harness_web/harness_channel.ex",
         "apps/server/src/provider/Layers/HarnessClientManager.ts"
       ]
     }}
  end

  def topic(slug) when is_binary(slug) do
    case Map.get(@centralized_topics, slug) do
      nil ->
        available = Enum.join(@all_topic_slugs, ", ")
        {:error, "Unknown topic: #{slug}. Available: #{available}"}

      topic_data ->
        {:ok, Map.put(topic_data, :topic, slug)}
    end
  end

  def topic(_), do: {:error, "Topic slug must be a string"}
end
