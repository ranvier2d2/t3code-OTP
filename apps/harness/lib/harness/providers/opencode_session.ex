defmodule Harness.Providers.OpenCodeSession do
  @moduledoc """
  Thread-owned wrapper around a shared OpenCode runtime.

  Each thread gets its own `OpenCodeSession` GenServer (one per thread_id),
  but instead of spawning its own `opencode serve` process, it **leases** a
  shared `OpenCodeRuntime` that is keyed by (cwd, binary path, config path,
  MCP config hash).

  Responsibilities kept here (thread-local):
  - OpenCode session CRUD (create / verify / delete) on the shared runtime
  - Turn lifecycle, event emission, permission handling
  - Filtering runtime SSE events for this thread's session
  - In-memory message buffer for read_thread

  Responsibilities moved to `OpenCodeRuntime` (shared):
  - Owning the `opencode serve` OS process
  - SSE listener and event fan-out
  - HTTP transport (all REST calls proxied through runtime)
  - MCP management (runtime-level config)

  SSE event types from OpenCode:
  - session.created, session.updated, session.deleted
  - message.updated, message.part.updated, message.part.delta, message.part.removed
  - permission.asked, permission.replied
  - server.connected, server.heartbeat

  ## Subagent Support

  OpenCode has a native agent/subagent architecture. Primary agents (Build, Plan)
  can delegate to subagents (General, Explore, custom) which run in child sessions.

  Handled subagent-related `message.part.updated` part types:
  - `"subtask"` → emits `item/started` with `itemType: "collab_agent_tool_call"`
  - `"agent"` → emits `session/state-changed` for agent switch tracking
  - `"step-start"` / `"step-finish"` → emits `item/started` / `item/completed`

  Child session tracking via `session.created` with `parentID`:
  - Emits `collab_agent_spawn_begin` with parent→child linkage
  """
  @behaviour Harness.Providers.ProviderBehaviour

  use GenServer, restart: :temporary

  alias Harness.Event
  alias Harness.OpenCode.RuntimeKey
  alias Harness.Providers.OpenCodeRuntime

  require Logger

  defstruct [
    :thread_id,
    :provider,
    :event_callback,
    :params,
    :opencode_session_id,
    :runtime_key,
    :runtime_pid,
    :runtime_ref,
    turn_state: nil,
    pending_permissions: %{},
    messages: [],
    stopped: false,
    ready: false,
    ready_waiters: [],
    reasoning_active: false,
    # H4 timing instrumentation: track SSE connect vs first permission.asked
    sse_connected_at: nil,
    first_permission_asked_at: nil,
    permission_timing_logged: false
  ]


  # --- Public API ---

  @impl Harness.Providers.ProviderBehaviour
  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, "opencode"}}
    )
  end

  @impl Harness.Providers.ProviderBehaviour
  def send_turn(pid, params) do
    GenServer.call(pid, {:send_turn, params}, 60_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def interrupt_turn(pid, _thread_id, _turn_id) do
    GenServer.call(pid, :interrupt_turn)
  end

  @impl Harness.Providers.ProviderBehaviour
  def respond_to_approval(pid, request_id, decision) do
    GenServer.call(pid, {:respond_to_approval, request_id, decision})
  end

  @impl Harness.Providers.ProviderBehaviour
  def respond_to_user_input(pid, request_id, answers) do
    GenServer.call(pid, {:respond_to_user_input, request_id, answers})
  end

  @impl Harness.Providers.ProviderBehaviour
  def read_thread(pid, _thread_id) do
    GenServer.call(pid, :read_thread, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def rollback_thread(pid, _thread_id, num_turns) do
    GenServer.call(pid, {:rollback_thread, num_turns}, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def stop(pid) do
    GenServer.stop(pid, :normal)
  end

  @impl Harness.Providers.ProviderBehaviour
  def wait_for_ready(pid, timeout \\ 30_000) do
    GenServer.call(pid, :wait_for_ready, timeout)
  end


  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    params = Map.get(opts, :params, %{})

    # Check for a persisted sessionId from resumeCursor so we can reuse the
    # existing OpenCode session instead of always starting from scratch.
    persisted_session_id = extract_persisted_session_id(params)

    runtime_key = RuntimeKey.from_params(params)

    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "opencode",
      event_callback: Map.fetch!(opts, :event_callback),
      params: params,
      opencode_session_id: persisted_session_id,
      runtime_key: runtime_key
    }

    # Lease the shared runtime asynchronously (it may need to spawn opencode)
    send(self(), :setup)
    {:ok, state}
  end

  @impl true
  def handle_info(:setup, state) do
    # Atomically lease (find or create) a shared runtime AND subscribe for events.
    # This eliminates the gap where we hold a lease but aren't yet monitored.
    case OpenCodeRuntime.lease_and_subscribe(
           state.runtime_key,
           state.params,
           state.thread_id,
           self()
         ) do
      {:ok, runtime_pid} ->
        # Wait for the runtime to be ready (opencode serve up + SSE connected)
        case OpenCodeRuntime.wait_for_ready(runtime_pid) do
          :ok ->
            setup_after_subscribe(state, runtime_pid)

          {:error, reason} ->
            Logger.error("OpenCode runtime failed to become ready: #{inspect(reason)}")
            {:stop, :server_timeout, state}
        end

      {:error, reason} ->
        Logger.error("Failed to lease OpenCode runtime: #{inspect(reason)}")
        {:stop, {:runtime_lease_failed, reason}, state}
    end
  end

  # Runtime process died - degrade gracefully
  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, %{runtime_ref: ref} = state) do
    unless state.stopped do
      Logger.warning(
        "OpenCode runtime died (#{inspect(reason)}) for thread #{state.thread_id}"
      )

      state = maybe_complete_turn(state, "failed")

      emit_event(state, :session, "session/exited", %{
        "exitStatus" => 1,
        "exitKind" => "error"
      })
    end

    {:stop, :normal, %{state | runtime_pid: nil, runtime_ref: nil}}
  end

  # Runtime notifies us it's shutting down
  @impl true
  def handle_info({:runtime_down, _pid, status}, state) do
    unless state.stopped do
      Logger.info("OpenCode runtime exited with status #{status} for thread #{state.thread_id}")

      state = maybe_complete_turn(state, if(status == 0, do: "completed", else: "failed"))

      emit_event(state, :session, "session/exited", %{
        "exitStatus" => status,
        "exitKind" => if(status == 0, do: "graceful", else: "error")
      })
    end

    {:stop, :normal, state}
  end

  # Runtime SSE connection exhausted all reconnect attempts
  @impl true
  def handle_info({:runtime_sse_degraded, _pid}, state) do
    Logger.warning("Runtime SSE degraded for thread #{state.thread_id} — live events unavailable")

    emit_event(state, :session, "session/degraded", %{
      "reason" => "sse_reconnect_exhausted"
    })

    {:noreply, state}
  end

  # SSE events fanned out from the shared runtime
  @impl true
  def handle_info({:runtime_sse_event, event}, state) do
    if event_relevant?(event, state) do
      state = handle_sse_event(event, state)
      {:noreply, state}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end


  # --- Wait for Ready ---

  @impl true
  def handle_call(:wait_for_ready, _from, %{ready: true} = state) do
    {:reply, :ok, state}
  end

  @impl true
  def handle_call(:wait_for_ready, from, state) do
    {:noreply, %{state | ready_waiters: [from | state.ready_waiters]}}
  end

  # --- Diagnostics ---

  @impl true
  def handle_call(:get_diagnostics, _from, state) do
    alias Harness.Dev.DiagnosticsHelpers, as: DH

    diagnostics = %{
      thread_id: state.thread_id,
      provider: state.provider,
      opencode_session_id: state.opencode_session_id,
      runtime_pid: state.runtime_pid,
      runtime_alive: state.runtime_pid != nil and Process.alive?(state.runtime_pid),
      ready: state.ready,
      stopped: state.stopped,
      reasoning_active: state.reasoning_active,
      turn_state: DH.sanitize_turn_state(state.turn_state),
      pending_permissions_count: map_size(state.pending_permissions),
      message_count: length(state.messages)
    }

    {:reply, {:ok, diagnostics}, state}
  end

  # --- Send Turn ---

  @impl true
  def handle_call({:send_turn, params}, _from, state) do
    state = maybe_complete_turn(state, "completed")

    turn_id = generate_id()
    input = Map.get(params, "input", [])

    text = extract_text_from_input(input)

    state = %{
      state
      | turn_state: %{
          turn_id: turn_id,
          started_at: now_iso(),
          items: []
        }
    }

    emit_event(state, :notification, "turn/started", %{
      "turn" => %{"id" => turn_id},
      "model" => Map.get(params, "model", Map.get(state.params, "model"))
    })

    # Build prompt body with text + image parts
    body = build_prompt_body(text, params)

    # Send via runtime (prompt_async, non-blocking)
    case OpenCodeRuntime.send_prompt(state.runtime_pid, state.opencode_session_id, body) do
      :ok ->
        resume_cursor =
          Jason.encode!(%{
            "threadId" => state.thread_id,
            "sessionId" => state.opencode_session_id
          })

        {:reply,
         {:ok,
          %{
            threadId: state.thread_id,
            turnId: turn_id,
            resumeCursor: resume_cursor
          }}, state}

      {:error, reason} ->
        state = maybe_complete_turn(state, "failed")
        {:reply, {:error, "Failed to send turn: #{inspect(reason)}"}, state}
    end
  end

  # --- Interrupt ---

  @impl true
  def handle_call(:interrupt_turn, _from, state) do
    # Abort the session via runtime
    if state.runtime_pid && state.opencode_session_id do
      OpenCodeRuntime.abort_session(state.runtime_pid, state.opencode_session_id)
    end

    state = maybe_complete_turn(state, "interrupted")
    {:reply, :ok, state}
  end

  # --- Approval ---

  @impl true
  def handle_call({:respond_to_approval, request_id, decision}, _from, state) do
    case Map.pop(state.pending_permissions, request_id) do
      {nil, _} ->
        {:reply, {:error, "Permission request not found: #{request_id}"}, state}

      {pending, remaining} ->
        state = %{state | pending_permissions: remaining}

        reply =
          case decision do
            "accept" -> "once"
            "acceptForSession" -> "always"
            _ -> "reject"
          end

        permission_id = Map.get(pending, :permission_id)

        case OpenCodeRuntime.reply_to_permission(
               state.runtime_pid,
               state.opencode_session_id,
               permission_id,
               reply
             ) do
          :ok ->
            emit_event(state, :notification, "request/resolved", %{
              "requestId" => request_id,
              "decision" => decision
            })

            {:reply, :ok, state}

          {:error, reason} ->
            {:reply, {:error, "Failed to reply to permission: #{inspect(reason)}"}, state}
        end
    end
  end

  # --- User Input ---

  @impl true
  def handle_call({:respond_to_user_input, request_id, answers}, _from, state) do
    # OpenCode handles user input through the question.asked/question.replied events
    case Map.pop(state.pending_permissions, request_id) do
      {nil, _} ->
        {:reply, {:error, "Question not found: #{request_id}"}, state}

      {pending, remaining} ->
        state = %{state | pending_permissions: remaining}

        # Reply to the OpenCode API with the user's answer
        permission_id = Map.get(pending, :permission_id) || Map.get(pending, :question_id)

        if permission_id do
          # Send the first answer as the reply text
          answer_text =
            cond do
              is_map(answers) ->
                # Web client sends %{"questionId" => "answer"}
                answers |> Map.values() |> List.first() |> to_string()

              is_list(answers) ->
                Enum.map_join(answers, "\n", &to_string/1)

              is_binary(answers) ->
                answers

              true ->
                ""
            end

          OpenCodeRuntime.reply_to_permission(
            state.runtime_pid,
            state.opencode_session_id,
            permission_id,
            answer_text
          )
        end

        emit_event(state, :notification, "user-input/resolved", %{
          "requestId" => request_id,
          "answers" => answers
        })

        {:reply, :ok, state}
    end
  end

  # --- Read Thread ---

  @impl true
  def handle_call(:read_thread, _from, state) do
    # If in-memory buffer is empty but we have an active session, try fetching
    # from the server as a read-only fallback (don't mutate state).
    messages =
      if state.messages == [] and state.opencode_session_id and state.runtime_pid do
        case OpenCodeRuntime.fetch_messages(state.runtime_pid, state.opencode_session_id) do
          {:ok, msgs} when msgs != [] -> server_messages_to_turns(msgs)
          _ -> []
        end
      else
        state.messages
      end

    thread = %{
      threadId: state.thread_id,
      turns:
        Enum.map(messages, fn m ->
          %{id: Map.get(m, :turn_id, ""), items: Map.get(m, :items, [])}
        end)
    }

    {:reply, {:ok, thread}, state}
  end

  # --- MCP Management (proxied through runtime) ---

  @impl true
  def handle_call(:mcp_status, _from, state) do
    result =
      if state.runtime_pid do
        OpenCodeRuntime.mcp_status(state.runtime_pid)
      else
        {:error, "No runtime available"}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_add, name, config}, _from, state) do
    result =
      if state.runtime_pid do
        OpenCodeRuntime.mcp_add(state.runtime_pid, name, config)
      else
        {:error, "No runtime available"}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_connect, name}, _from, state) do
    result =
      if state.runtime_pid do
        OpenCodeRuntime.mcp_connect(state.runtime_pid, name)
      else
        {:error, "No runtime available"}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_disconnect, name}, _from, state) do
    result =
      if state.runtime_pid do
        OpenCodeRuntime.mcp_disconnect(state.runtime_pid, name)
      else
        {:error, "No runtime available"}
      end

    {:reply, result, state}
  end

  # --- List Models (HTTP-based discovery via runtime) ---

  @impl true
  def handle_call(:list_models, _from, state) do
    result =
      if state.runtime_pid do
        case OpenCodeRuntime.fetch_providers(state.runtime_pid) do
          {:ok, providers} -> {:ok, extract_models_from_providers(providers)}
          {:error, reason} -> {:error, reason}
        end
      else
        {:error, "No runtime available"}
      end

    {:reply, result, state}
  end

  # --- Rollback ---

  @impl true
  def handle_call({:rollback_thread, num_turns}, _from, state) do
    messages = if num_turns > 0, do: Enum.drop(state.messages, -num_turns), else: state.messages
    state = %{state | messages: messages}

    # Revert via OpenCode API through runtime if session exists
    if state.opencode_session_id && num_turns > 0 && state.runtime_pid do
      OpenCodeRuntime.revert_session(state.runtime_pid, state.opencode_session_id)
    end

    {:reply, {:ok, %{threadId: state.thread_id, turns: []}}, state}
  end


  @impl true
  def terminate(_reason, state) do
    state = %{state | stopped: true}
    emit_event(state, :session, "session/closed", %{})

    # Cancel pending approvals/elicitations so SQLite rows are cleaned up
    cancel_all_pending(state)

    # Best-effort cleanup: delete the OpenCode session from the runtime
    if state.runtime_pid && state.opencode_session_id do
      try do
        OpenCodeRuntime.delete_session(state.runtime_pid, state.opencode_session_id)
      rescue
        _ -> :ok
      catch
        _, _ -> :ok
      end
    end

    # Reject ready waiters
    Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, "Session terminated"}))

    # Release our lease on the shared runtime
    if state.runtime_key do
      OpenCodeRuntime.release(state.runtime_key, state.thread_id)
    end

    # Demonitor runtime
    if state.runtime_ref do
      Process.demonitor(state.runtime_ref, [:flush])
    end

    :ok
  end


  # --- Private: Setup after Lease+Subscribe ---

  defp setup_after_subscribe(state, runtime_pid) do
    # Monitor the runtime so we know if it dies
    runtime_ref = Process.monitor(runtime_pid)

    # NOTE: subscribe already happened in lease_and_subscribe/4
    sse_connected_at = System.monotonic_time(:millisecond)

    state = %{
      state
      | runtime_pid: runtime_pid,
        runtime_ref: runtime_ref,
        sse_connected_at: sse_connected_at
    }

    Logger.info(
      "[H4-TIMING] SSE connect initiated at mono=#{sse_connected_at}ms for thread #{state.thread_id}"
    )

    # Reuse a persisted session when available; otherwise create a new one.
    # This preserves conversation history across session restarts/resumes.
    {session_result, _reused} =
      if state.opencode_session_id do
        # Verify the persisted session still exists on the runtime
        case OpenCodeRuntime.verify_session(runtime_pid, state.opencode_session_id) do
          :ok ->
            Logger.info(
              "Reusing persisted OpenCode session #{state.opencode_session_id} for thread #{state.thread_id}"
            )

            {{:ok, state.opencode_session_id}, true}

          {:error, reason} ->
            Logger.info(
              "Persisted OpenCode session invalid (#{inspect(reason)}), creating new session for thread #{state.thread_id}"
            )

            {OpenCodeRuntime.create_session(runtime_pid, state.thread_id), false}
        end
      else
        {OpenCodeRuntime.create_session(runtime_pid, state.thread_id), false}
      end

    case session_result do
      {:ok, session_id} ->
        state = %{state | opencode_session_id: session_id, ready: true}

        # Hydrate message history from server on resume so read_thread
        # returns prior turns even after GenServer crash/restart.
        state =
          case OpenCodeRuntime.fetch_messages(runtime_pid, session_id) do
            {:ok, msgs} when msgs != [] ->
              turns = server_messages_to_turns(msgs)

              Logger.info(
                "Hydrated #{length(turns)} turns from server for thread #{state.thread_id}"
              )

              %{state | messages: turns}

            _ ->
              state
          end

        emit_event(state, :session, "session/started", %{
          "sessionId" => session_id,
          "model" => Map.get(state.params, "model"),
          "cwd" => Map.get(state.params, "cwd")
        })

        emit_event(state, :session, "session/ready", %{})
        persist_binding(state)
        # Rehydrate MCP server status from REST API so the panel
        # populates immediately — SSE is forward-only and won't replay
        # startup events that fired before we connected.
        rehydrate_mcp_status(state)
        # Notify any callers waiting for ready
        Enum.each(state.ready_waiters, &GenServer.reply(&1, :ok))
        state = %{state | ready_waiters: []}
        {:noreply, state}

      {:error, reason} ->
        emit_event(state, :session, "session/state-changed", %{
          "state" => "error",
          "error" => inspect(reason)
        })

        emit_event(state, :error, "runtime/error", %{
          "message" => "Session creation failed: #{inspect(reason)}",
          "class" => "provider_error"
        })

        {:stop, {:session_create_failed, reason}, state}
    end
  end

  defp cancel_all_pending(state) do
    Enum.each(state.pending_permissions, fn {request_id, pending} ->
      if Map.get(pending, :question_id) do
        emit_event(state, :notification, "user-input/resolved", %{
          "requestId" => request_id,
          "answers" => %{}
        })
      else
        emit_event(state, :notification, "request/resolved", %{
          "requestId" => request_id,
          "decision" => "cancel"
        })
      end
    end)
  end


  # --- SSE Event Filtering ---

  # Determine whether an SSE event from the shared runtime is relevant to
  # this thread's session. Events without a detectable session association
  # are passed through (e.g. server.heartbeat, server.connected).
  defp event_relevant?(%{"type" => type}, _state)
       when type in ["server.heartbeat", "server.connected"] do
    true
  end

  defp event_relevant?(%{"data" => data}, state) when is_map(data) do
    session_id = state.opencode_session_id

    # Check common locations for session association in OpenCode events
    event_session =
      Map.get(data, "sessionId") ||
        Map.get(data, "session_id") ||
        Map.get(data, "id") ||
        get_in(data, ["info", "id"]) ||
        get_in(data, ["info", "parentID"])

    # If the event has a session identifier, check it matches ours.
    # If no session identifier found, pass through (could be a message-level event
    # that's contextually bound to the active session).
    is_nil(event_session) or event_session == session_id
  end

  defp event_relevant?(event, _state) do
    Logger.debug("Dropping unrecognized SSE event shape: #{inspect(Map.get(event, "type", "unknown"), limit: 100)}")
    false
  end

  # --- SSE Event Handling ---

  defp handle_sse_event(%{"type" => "message.part.delta", "data" => data}, state) do
    # Streaming text delta
    delta = Map.get(data, "delta", "")
    field = Map.get(data, "field", "text")

    Logger.debug(
      "OpenCode delta: field=#{inspect(field)} reasoning_active=#{state.reasoning_active} preview=#{String.slice(delta, 0, 60)}"
    )

    # Determine stream kind: explicit "reasoning" field takes priority,
    # otherwise use the reasoning_active flag set by message.part.updated
    # to distinguish reasoning text from assistant text when both arrive
    # with field="text".
    stream_kind =
      cond do
        field == "reasoning" -> "reasoning_text"
        state.reasoning_active -> "reasoning_text"
        true -> "assistant_text"
      end

    if delta != "" do
      emit_event(state, :notification, "content/delta", %{
        "streamKind" => stream_kind,
        "delta" => delta,
        "turnId" => turn_id_from_state(state)
      })
    end

    state
  end

  defp handle_sse_event(%{"type" => "message.part.updated", "data" => data}, state) do
    part = Map.get(data, "part", data)
    part_type = Map.get(part, "type", "unknown")

    # Track reasoning phase: when a new part starts with a reasoning-related
    # type (e.g. "reasoning", "step" with reasoning content), enter reasoning
    # mode. When a "text" part starts, exit reasoning mode.
    state =
      cond do
        part_type in ["reasoning", "thinking"] ->
          %{state | reasoning_active: true}

        part_type == "step" ->
          %{state | reasoning_active: true}

        part_type == "text" ->
          %{state | reasoning_active: false}

        part_type == "tool" ->
          %{state | reasoning_active: false}

        true ->
          state
      end

    turn_id = turn_id_from_state(state)

    case part_type do
      "tool" ->
        handle_tool_part(state, part, turn_id)

      "text" ->
        # Full text arrives here but message.part.delta already streams it.
        state

      "subtask" ->
        handle_subtask_part(state, part, turn_id)

      "agent" ->
        agent_name = Map.get(part, "name", "unknown")
        Logger.info("OpenCode agent switch: #{agent_name}")

        emit_event(state, :notification, "session/state-changed", %{
          "state" => "running",
          "agent" => agent_name,
          "turnId" => turn_id
        })

        state

      "step-start" ->
        step_id = Map.get(part, "id") || generate_id()
        tool_name = Map.get(part, "tool") || Map.get(part, "name") || "step"
        description = Map.get(part, "description", "")
        step_input = Map.get(part, "input") || Map.get(part, "args") || %{}

        emit_event(state, :notification, "item/started", %{
          "itemId" => step_id,
          "itemType" => "dynamic_tool_call",
          "toolName" => tool_name,
          "detail" => description,
          "args" => step_input,
          "turnId" => turn_id
        })

        state

      "step-finish" ->
        step_id = Map.get(part, "id") || generate_id()
        tool_name = Map.get(part, "tool") || Map.get(part, "name") || "step"
        step_output = Map.get(part, "output") || Map.get(part, "result") || %{}

        emit_event(state, :notification, "item/completed", %{
          "itemId" => step_id,
          "itemType" => "dynamic_tool_call",
          "toolName" => tool_name,
          "status" => "completed",
          "output" => step_output,
          "turnId" => turn_id
        })

        state

      _ ->
        state
    end
  end

  defp handle_sse_event(%{"type" => "message.updated", "data" => data}, state) do
    role = Map.get(data, "role")

    cond do
      role == "assistant" && Map.has_key?(data, "error") && Map.get(data, "error") != nil ->
        error = Map.get(data, "error")

        emit_event(state, :error, "runtime/error", %{
          "message" => inspect(error),
          "class" => "provider_error"
        })

        maybe_complete_turn(state, "failed")

      true ->
        state
    end
  end

  defp handle_sse_event(%{"type" => "permission.asked", "data" => data}, state) do
    handle_permission_asked(state, data)
  end

  defp handle_sse_event(%{"type" => "question.asked", "data" => data}, state) do
    request_id = generate_id()
    question = Map.get(data, "question", "")
    options = Map.get(data, "options", [])

    questions = [
      %{
        "id" => Map.get(data, "id", request_id),
        "question" => question,
        "options" => options
      }
    ]

    pending = %{
      question_id: Map.get(data, "id"),
      questions: questions
    }

    state = %{
      state
      | pending_permissions: Map.put(state.pending_permissions, request_id, pending)
    }

    emit_event(state, :request, "user-input/requested", %{
      "requestId" => request_id,
      "questions" => questions
    })

    state
  end

  defp handle_sse_event(%{"type" => "session.created", "data" => data}, state) do
    info = Map.get(data, "info", data)
    parent_id = Map.get(info, "parentID")

    if parent_id do
      child_id = Map.get(info, "id", generate_id())
      agent_name = Map.get(info, "title", "subagent")
      Logger.info("OpenCode child session created: #{child_id} parent=#{parent_id}")

      emit_event(state, :notification, "collab_agent_spawn_begin", %{
        "agentId" => child_id,
        "agentName" => agent_name,
        "parentSessionId" => parent_id,
        "turnId" => turn_id_from_state(state)
      })
    end

    state
  end

  defp handle_sse_event(%{"type" => "session.updated", "data" => _data}, state) do
    # Note: do NOT emit session/state-changed -> running here.
    # session.status -> busy already handles that, and session.updated can arrive
    # AFTER session.status -> idle, which would reset the sidebar back to "Working"
    # and leave it stuck there permanently.
    state
  end

  # session.status carries the OpenCode-native status (busy/idle)
  defp handle_sse_event(%{"type" => "session.status", "data" => data}, state) do
    status_type = get_in(data, ["status", "type"])

    case status_type do
      "idle" ->
        state = maybe_complete_turn(state, "completed")
        emit_event(state, :session, "session/state-changed", %{"state" => "ready"})
        state

      "busy" ->
        emit_event(state, :session, "session/state-changed", %{"state" => "running"})
        state

      _ ->
        state
    end
  end

  # session.idle means OpenCode finished processing
  defp handle_sse_event(%{"type" => "session.idle"}, state) do
    maybe_complete_turn(state, "completed")
  end

  defp handle_sse_event(%{"type" => "server.heartbeat"}, state), do: state
  defp handle_sse_event(%{"type" => "server.connected"}, state), do: state

  defp handle_sse_event(%{"type" => type, "data" => data}, state) do
    # Forward unhandled events as raw harness events
    emit_event(state, :notification, type, data)
    state
  end

  defp handle_sse_event(_, state), do: state


  # --- Private: Tool Part Handler ---

  defp handle_tool_part(state, part, turn_id) do
    tool_name = Map.get(part, "tool", "unknown")
    tool_state = get_in(part, ["state"]) || %{}
    status = Map.get(tool_state, "status", "pending")
    call_id = Map.get(part, "callID")

    item_type = classify_tool_item_type(tool_name)
    detail = extract_tool_detail(part)
    input = Map.get(tool_state, "input") || %{}

    case status do
      "running" ->
        emit_event(state, :notification, "item/started", %{
          "itemId" => call_id,
          "itemType" => item_type,
          "toolName" => tool_name,
          "detail" => detail,
          "args" => input,
          "turnId" => turn_id
        })

      "completed" ->
        output = extract_tool_output(part)

        if output != "" do
          stream_kind =
            case item_type do
              "command_execution" -> "command_output"
              "file_change" -> "file_change_output"
              _ -> "tool_output"
            end

          emit_event(state, :notification, "content/delta", %{
            "streamKind" => stream_kind,
            "delta" => output,
            "itemId" => call_id,
            "turnId" => turn_id
          })
        end

        emit_event(state, :notification, "item/completed", %{
          "itemId" => call_id,
          "itemType" => item_type,
          "toolName" => tool_name,
          "status" => "completed",
          "args" => input,
          "output" => extract_tool_output_structured(part),
          "turnId" => turn_id
        })

      "error" ->
        error_info = Map.get(tool_state, "error", "")

        emit_event(state, :notification, "item/completed", %{
          "itemId" => call_id,
          "itemType" => item_type,
          "toolName" => tool_name,
          "status" => "failed",
          "args" => input,
          "error" => error_info,
          "turnId" => turn_id
        })

      _ ->
        :ok
    end

    state
  end

  # --- Private: Subtask Part Handler ---

  defp handle_subtask_part(state, part, turn_id) do
    agent_name = Map.get(part, "agent", "subagent")
    prompt = Map.get(part, "prompt", "")
    description = Map.get(part, "description", "")
    subtask_id = Map.get(part, "id") || generate_id()

    emit_event(state, :notification, "item/started", %{
      "itemId" => subtask_id,
      "itemType" => "collab_agent_tool_call",
      "toolName" => agent_name,
      "detail" => if(description != "", do: description, else: String.slice(prompt, 0, 100)),
      "args" => %{
        "agent" => agent_name,
        "prompt" => prompt,
        "description" => description
      },
      "turnId" => turn_id
    })

    state
  end

  # --- Private: Permission Handler ---

  defp handle_permission_asked(state, data) do
    permission_id = Map.get(data, "id")
    permission = Map.get(data, "permission", "unknown")
    metadata = Map.get(data, "metadata", %{})
    runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

    # H4 timing instrumentation: log first permission.asked relative to SSE connect
    state =
      if state.permission_timing_logged do
        state
      else
        now = System.monotonic_time(:millisecond)
        state = %{state | first_permission_asked_at: now, permission_timing_logged: true}
        gap = if state.sse_connected_at, do: now - state.sse_connected_at, else: nil

        Logger.info(
          "[H4-TIMING] First permission.asked at mono=#{now}ms, " <>
            "SSE connected at mono=#{state.sse_connected_at}ms, " <>
            "gap=#{inspect(gap)}ms, " <>
            "permission=#{permission}, thread=#{state.thread_id}"
        )

        emit_event(state, :notification, "h4/permission-timing", %{
          "sseConnectedAt" => state.sse_connected_at,
          "firstPermissionAskedAt" => now,
          "gapMs" => gap,
          "permission" => permission,
          "threadId" => state.thread_id
        })

        state
      end

    if runtime_mode == "full-access" do
      # Auto-approve in full-access mode
      Logger.info("Auto-approving permission #{permission} (full-access mode)")

      OpenCodeRuntime.reply_to_permission(
        state.runtime_pid,
        state.opencode_session_id,
        permission_id,
        "always"
      )

      state
    else
      request_id = generate_id()

      pending = %{
        permission_id: permission_id,
        permission: permission,
        request_type: classify_permission_type(permission),
        detail: extract_permission_detail(data)
      }

      state = %{
        state
        | pending_permissions: Map.put(state.pending_permissions, request_id, pending)
      }

      emit_event(state, :request, "request/opened", %{
        "requestId" => request_id,
        "requestType" => pending.request_type,
        "detail" => pending.detail,
        "args" => %{
          "toolName" => permission,
          "permission" => permission,
          "input" => metadata,
          "patterns" => Map.get(data, "patterns", [])
        }
      })

      state
    end
  end


  # --- Persisted Session ID ---

  defp extract_persisted_session_id(params) do
    case get_in(params, ["resumeCursor"]) do
      nil ->
        nil

      cursor when is_binary(cursor) ->
        case Jason.decode(cursor) do
          {:ok, %{"sessionId" => id}} when is_binary(id) -> id
          _ -> nil
        end

      # Already-decoded map (normalize_resume_cursor or direct map value)
      %{"sessionId" => id} when is_binary(id) ->
        id

      _ ->
        nil
    end
  end

  # --- Prompt Body Builder ---

  defp build_prompt_body(text, params) do
    if model = Map.get(params || %{}, "model") do
      Logger.warning(
        "OpenCode ignores per-turn model override: #{inspect(model)}. Model is fixed at session creation."
      )
    end

    text_parts = [%{"type" => "text", "text" => text}]
    attachments = Map.get(params || %{}, "attachments", [])

    image_parts =
      case Harness.ImageProcessor.parse_attachments(attachments) do
        {:ok, images} ->
          Enum.map(images, &Harness.ImageProcessor.to_opencode_part/1)

        {:error, reason} ->
          Logger.warning("Image processing failed for OpenCode turn: #{inspect(reason)}")
          []
      end

    %{"parts" => text_parts ++ image_parts}
  end

  # --- Turn Management ---

  defp maybe_complete_turn(%{turn_state: nil} = state, _status), do: state

  defp maybe_complete_turn(state, status) do
    turn = state.turn_state

    emit_event(state, :notification, "turn/completed", %{
      "turn" => %{
        "id" => turn.turn_id,
        "status" => status
      },
      "stopReason" => status
    })

    emit_event(state, :session, "session/state-changed", %{"state" => "ready"})

    %{state | turn_state: nil, messages: state.messages ++ [turn]}
  end

  # --- Server Message Conversion ---

  defp server_messages_to_turns(messages) when is_list(messages) do
    messages
    |> Enum.filter(fn msg -> get_in(msg, ["info", "role"]) == "assistant" end)
    |> Enum.map(fn msg ->
      %{
        turn_id: get_in(msg, ["info", "id"]) || generate_id(),
        started_at: server_message_started_at(msg),
        items:
          (Map.get(msg, "parts", []) || [])
          |> Enum.flat_map(fn part ->
            case Map.get(part, "type") do
              "text" ->
                text = Map.get(part, "text", "")
                if text != "", do: [%{"type" => "text", "text" => text}], else: []

              "tool" ->
                [
                  %{
                    "type" => "tool",
                    "tool" => Map.get(part, "tool", "unknown"),
                    "state" => Map.get(part, "state", %{})
                  }
                ]

              _ ->
                []
            end
          end)
      }
    end)
  end

  defp server_messages_to_turns(_), do: []

  # --- Model Discovery ---

  defp extract_models_from_providers(providers) when is_list(providers) do
    Enum.flat_map(providers, fn provider_data ->
      provider_id = Map.get(provider_data, "id")
      models = Map.get(provider_data, "models", %{})

      if is_binary(provider_id) and is_map(models) do
        Enum.map(models, fn {model_key, model_data} ->
          slug = "#{provider_id}/#{model_key}"
          name = Map.get(model_data, "name", model_key)
          %{"slug" => slug, "name" => name}
        end)
      else
        []
      end
    end)
  end

  defp extract_models_from_providers(_), do: []

  # --- Helpers ---

  defp turn_id_from_state(%{turn_state: %{turn_id: turn_id}}), do: turn_id
  defp turn_id_from_state(_), do: nil

  defp server_message_started_at(message) do
    message
    |> get_in(["info", "time", "created"])
    |> unix_timestamp_to_iso()
  end

  defp unix_timestamp_to_iso(timestamp) when is_integer(timestamp) do
    {value, unit} =
      cond do
        timestamp >= 100_000_000_000_000 -> {timestamp, :microsecond}
        timestamp >= 100_000_000_000 -> {timestamp, :millisecond}
        true -> {timestamp, :second}
      end

    case DateTime.from_unix(value, unit) do
      {:ok, datetime} -> DateTime.to_iso8601(datetime)
      _ -> now_iso()
    end
  end

  defp unix_timestamp_to_iso(_), do: now_iso()

  defp persist_binding(state) do
    # Only persist durable identifiers — port is ephemeral and stale after restart.
    # Include mcpConfigVersion so on resume we can detect config drift.
    cursor_json =
      Jason.encode!(
        %{
          "threadId" => state.thread_id,
          "sessionId" => state.opencode_session_id
        }
        |> maybe_put_mcp_config_version(state)
      )

    Harness.Storage.upsert_binding(state.thread_id, state.provider, cursor_json)
  end

  defp maybe_put_mcp_config_version(cursor, state) do
    case Map.get(state.params, "mcp_config") do
      %{"version" => v} when is_binary(v) -> Map.put(cursor, "mcpConfigVersion", v)
      _ -> cursor
    end
  end

  # Fetch MCP server status from OpenCode REST API and emit
  # mcpServer/startupStatus/updated events for each server.  This rehydrates
  # the MCP panel after SSE reconnect or on initial setup (SSE is forward-only
  # and doesn't replay events missed during a connection gap).
  defp rehydrate_mcp_status(state) do
    case OpenCodeRuntime.mcp_status(state.runtime_pid) do
      {:ok, servers} when is_map(servers) ->
        count = map_size(servers)

        if count > 0 do
          Logger.info(
            "Rehydrating #{count} MCP server statuses for thread #{state.thread_id}"
          )
        end

        Enum.each(servers, fn {name, raw} ->
          status =
            case raw do
              %{"status" => s} when is_binary(s) -> s
              _ -> "unknown"
            end

          error_msg =
            case raw do
              %{"error" => e} when is_binary(e) -> e
              _ -> nil
            end

          emit_event(state, :notification, "mcpServer/startupStatus/updated", %{
            "server" => name,
            "status" => %{"state" => status},
            "error" => error_msg,
            "source" => "rehydration",
            "sessionId" => state.opencode_session_id
          })
        end)

      {:error, reason} ->
        Logger.debug(
          "MCP status rehydration skipped for thread #{state.thread_id}: #{inspect(reason)}"
        )

      _ ->
        :ok
    end
  end

  defp emit_event(state, kind, method, payload) do
    # Tag events with the OpenCode session ID for attribution.
    # Currently the harness assumes 1:1 process-to-session mapping,
    # but this prepares for shared-runtime (multiple sessions per
    # opencode serve process) where events need explicit scoping.
    attributed_payload =
      if state.opencode_session_id do
        Map.put_new(payload, "opencode_session_id", state.opencode_session_id)
      else
        payload
      end

    event =
      Event.new(%{
        thread_id: state.thread_id,
        provider: state.provider,
        kind: kind,
        method: method,
        payload: attributed_payload
      })

    state.event_callback.(event)
  end

  defp extract_text_from_input(input) when is_list(input) do
    Enum.map_join(input, "\n", fn
      %{"type" => "text", "text" => text} -> text
      %{"text" => text} -> text
      item when is_binary(item) -> item
      _ -> ""
    end)
  end

  defp extract_text_from_input(input) when is_binary(input), do: input
  defp extract_text_from_input(_), do: ""

  defp classify_tool_item_type(tool_name) do
    name = String.downcase(to_string(tool_name))

    cond do
      String.contains?(name, "bash") or String.contains?(name, "command") or
          String.contains?(name, "shell") ->
        "command_execution"

      String.contains?(name, "edit") or String.contains?(name, "write") or
        String.contains?(name, "file") or String.contains?(name, "patch") ->
        "file_change"

      String.contains?(name, "read") or String.contains?(name, "glob") or
          String.contains?(name, "grep") ->
        "file_read"

      String.contains?(name, "mcp") ->
        "mcp_tool_call"

      String.contains?(name, "agent") or String.contains?(name, "task") ->
        "collab_agent_tool_call"

      String.contains?(name, "web") and String.contains?(name, "search") ->
        "web_search"

      true ->
        "dynamic_tool_call"
    end
  end

  defp extract_tool_detail(part) do
    input = get_in(part, ["state", "input"]) || %{}

    Map.get(input, "command") ||
      Map.get(input, "file_path") ||
      Map.get(input, "filePath") ||
      Map.get(input, "path") ||
      Map.get(input, "query") ||
      Map.get(input, "pattern") ||
      Map.get(part, "tool")
  end

  defp extract_tool_output(part) do
    tool_state = get_in(part, ["state"]) || %{}
    output = Map.get(tool_state, "output", "")
    result = Map.get(tool_state, "result", "")

    cond do
      is_binary(output) and output != "" -> output
      is_binary(result) and result != "" -> result
      true -> ""
    end
  end

  defp extract_tool_output_structured(part) do
    tool_state = get_in(part, ["state"]) || %{}
    output = Map.get(tool_state, "output")
    result = Map.get(tool_state, "result")

    cond do
      not is_nil(output) and output != "" -> output
      not is_nil(result) and result != "" -> result
      true -> nil
    end
  end

  defp classify_permission_type(permission) do
    case permission do
      "file.write" -> "file_change_approval"
      "file.read" -> "file_read_approval"
      "shell.execute" -> "command_execution_approval"
      _ -> "dynamic_tool_call"
    end
  end

  defp extract_permission_detail(data) do
    patterns = Map.get(data, "patterns", [])
    metadata = Map.get(data, "metadata", %{})

    Map.get(metadata, "command") ||
      Map.get(metadata, "path") ||
      List.first(patterns) ||
      Map.get(data, "permission")
  end

  defp generate_id do
    Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)
    |> then(fn hex ->
      <<a::binary-size(8), b::binary-size(4), c::binary-size(4), d::binary-size(4),
        e::binary-size(12)>> = hex

      "#{a}-#{b}-#{c}-#{d}-#{e}"
    end)
  end

  defp now_iso do
    DateTime.utc_now() |> DateTime.to_iso8601()
  end
end
