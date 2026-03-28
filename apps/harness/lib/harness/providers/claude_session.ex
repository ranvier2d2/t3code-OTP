defmodule Harness.Providers.ClaudeSession do
  @moduledoc """
  GenServer managing a single Claude Code session.

  Mirrors Julius's ClaudeAdapter patterns from PR #179 but in Elixir/OTP:
  - Spawns `claude` binary via Erlang Port with --output-format=stream-json
  - Manages session lifecycle: start → ready → running → completed → ready
  - Handles approval requests via canUseTool callback bridge
  - Handles user input (AskUserQuestion) via the same bridge
  - Tracks in-flight tools, turn state, resume cursor
  - Multi-turn via sending new messages to stdin

  Key difference from TypeScript: The SDK's `query()` function spawns claude
  internally and returns an AsyncIterable. Here we spawn claude directly and
  parse its stdout JSON stream ourselves — same wire format, no SDK wrapper needed.
  """
  use GenServer, restart: :temporary

  alias Harness.Event

  require Logger

  defstruct [
    :thread_id,
    :provider,
    :port,
    :event_callback,
    :params,
    :buffer,
    :session_id,
    :resume_session_id,
    :last_assistant_uuid,
    :binary_path,
    turn_state: nil,
    pending_approvals: %{},
    pending_user_inputs: %{},
    in_flight_tools: %{},
    turns: [],
    stopped: false
  ]

  # --- Public API ---

  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, "claudeAgent"}}
    )
  end

  def send_turn(pid, params) do
    GenServer.call(pid, {:send_turn, params}, 30_000)
  end

  def interrupt_turn(pid, _thread_id, _turn_id) do
    GenServer.call(pid, :interrupt_turn)
  end

  def respond_to_approval(pid, request_id, decision) do
    GenServer.call(pid, {:respond_to_approval, request_id, decision})
  end

  def respond_to_user_input(pid, request_id, answers) do
    GenServer.call(pid, {:respond_to_user_input, request_id, answers})
  end

  def read_thread(pid, _thread_id) do
    GenServer.call(pid, :read_thread, 30_000)
  end

  def rollback_thread(pid, _thread_id, num_turns) do
    GenServer.call(pid, {:rollback_thread, num_turns}, 30_000)
  end

  def wait_for_ready(_pid, _timeout \\ 30_000) do
    # Unlike CodexSession which starts a persistent process in init,
    # ClaudeSession spawns the CLI process lazily on each send_turn.
    # The GenServer itself is ready immediately after start_link.
    :ok
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "claudeAgent",
      event_callback: Map.fetch!(opts, :event_callback),
      params: Map.get(opts, :params, %{}),
      buffer: "",
      binary_path: resolve_claude_binary(opts),
      session_id: generate_uuid()
    }

    # Parse resume state if provided
    state = parse_resume_state(state)

    # Don't spawn claude yet — spawn on first send_turn with the actual prompt.
    # Claude CLI's --print mode requires a prompt argument.
    emit_event(state, :session, "session/started", %{
      "model" => Map.get(state.params, "model"),
      "cwd" => Map.get(state.params, "cwd")
    })

    emit_event(state, :session, "session/ready", %{})

    {:ok, state}
  end

  # Port data received (stdout from claude process)
  @impl true
  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    full_line = state.buffer <> to_string(line)
    state = process_line(full_line, %{state | buffer: ""})
    {:noreply, state}
  end

  @impl true
  def handle_info({port, {:data, {:noeol, chunk}}}, %{port: port} = state) do
    {:noreply, %{state | buffer: state.buffer <> to_string(chunk)}}
  end

  # Port exit — claude --print exits after each turn.
  # On graceful exit (status 0): stay alive for multi-turn, reset port to nil.
  # On error exit: stop the GenServer.
  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    state =
      if state.stopped do
        state
      else
        Logger.info("Claude process exited with status #{status} for thread #{state.thread_id}")

        # Complete any active turn
        completed = maybe_complete_turn(state, if(status == 0, do: "completed", else: "failed"))

        if status != 0 do
          emit_event(completed, :session, "session/exited", %{
            "exitStatus" => status,
            "exitKind" => "error"
          })
        end

        completed
      end

    if status == 0 and not state.stopped do
      # Graceful exit — stay alive for next turn, clear port and buffer
      state = %{state | port: nil, buffer: ""}
      state = cancel_all_pending(state)
      emit_event(state, :session, "session/ready", %{})
      {:noreply, state}
    else
      # Error or explicit stop — terminate the GenServer
      state = cancel_all_pending(state)
      {:stop, :normal, state}
    end
  end

  # {:spawn, ...} sends raw binary data (not {:eol, ...} tuples)
  @impl true
  def handle_info({port, {:data, data}}, %{port: port} = state) when is_binary(data) do
    buffer = state.buffer <> data
    {lines, remaining} = split_lines(buffer)
    state = %{state | buffer: remaining}
    state = Enum.reduce(lines, state, &process_line/2)
    {:noreply, state}
  end

  @impl true
  def handle_info(msg, state) do
    Logger.debug("ClaudeSession unhandled message: #{inspect(msg, limit: 200)}")
    {:noreply, state}
  end

  # --- Diagnostics ---

  @impl true
  def handle_call(:get_diagnostics, _from, state) do
    alias Harness.Dev.DiagnosticsHelpers, as: DH

    diagnostics = %{
      thread_id: state.thread_id,
      provider: state.provider,
      session_id: state.session_id,
      resume_session_id: state.resume_session_id,
      binary_path: state.binary_path,
      stopped: state.stopped,
      port_alive: DH.port_alive?(state.port),
      turn_state: DH.sanitize_turn_state(state.turn_state),
      pending_approvals_count: map_size(state.pending_approvals),
      pending_user_inputs_count: map_size(state.pending_user_inputs),
      in_flight_tools_count: map_size(state.in_flight_tools),
      turn_count: length(state.turns),
      buffer_bytes: byte_size(state.buffer || "")
    }

    {:reply, {:ok, diagnostics}, state}
  end

  # --- Send Turn ---

  @impl true
  def handle_call({:send_turn, params}, _from, state) do
    # Auto-complete any stale turn and kill previous process
    state = maybe_complete_turn(state, "completed")

    state =
      if state.port do
        try do
          Port.close(state.port)
        catch
          _, _ -> :ok
        end

        %{state | port: nil}
      else
        state
      end

    turn_id = generate_uuid()
    input = Map.get(params, "input", [])
    text = extract_text_from_input(input)

    turn_state = %{
      turn_id: turn_id,
      started_at: now_iso(),
      items: []
    }

    state = %{state | turn_state: turn_state}

    emit_event(state, :notification, "turn/started", %{
      "turn" => %{"id" => turn_id},
      "model" => Map.get(params, "model", Map.get(state.params, "model"))
    })

    # Spawn claude with --print and the prompt as argument
    model = Map.get(params, "model", Map.get(state.params, "model", "claude-sonnet-4-6"))

    case spawn_claude_with_prompt(state, model, text) do
      {:ok, port} ->
        state = %{state | port: port}
        resume_cursor = build_resume_cursor(state)

        {:reply,
         {:ok,
          %{
            threadId: state.thread_id,
            turnId: turn_id,
            resumeCursor: resume_cursor
          }}, state}

      {:error, reason} ->
        Logger.error("Failed to spawn claude: #{inspect(reason)}")
        state = maybe_complete_turn(state, "failed")

        emit_event(state, :error, "runtime/error", %{
          "message" => "Failed to spawn claude: #{inspect(reason)}",
          "class" => "spawn_error"
        })

        {:reply, {:error, "Failed to spawn claude: #{inspect(reason)}"}, state}
    end
  end

  # --- Interrupt ---

  @impl true
  def handle_call(:interrupt_turn, _from, state) do
    if state.port do
      # Send SIGINT to claude process
      try do
        port_info = Port.info(state.port)

        if port_info do
          os_pid = Keyword.get(port_info, :os_pid)
          if os_pid, do: System.cmd("kill", ["-2", to_string(os_pid)], stderr_to_stdout: true)
        end
      catch
        _, _ -> :ok
      end
    end

    state = maybe_complete_turn(state, "interrupted")
    {:reply, :ok, state}
  end

  # --- Approval Response ---

  @impl true
  def handle_call({:respond_to_approval, request_id, decision}, _from, state) do
    case Map.pop(state.pending_approvals, request_id) do
      {nil, _} ->
        {:reply, {:error, "Approval request not found: #{request_id}"}, state}

      {pending, remaining} ->
        state = %{state | pending_approvals: remaining}

        # Send the decision back to the claude process via stdin
        response = build_approval_response(pending, decision)
        send_to_port(state, response)

        emit_event(state, :notification, "request/resolved", %{
          "requestId" => request_id,
          "decision" => decision,
          "requestType" => Map.get(pending, :request_type, "unknown")
        })

        {:reply, :ok, state}
    end
  end

  # --- User Input Response ---

  @impl true
  def handle_call({:respond_to_user_input, request_id, answers}, _from, state) do
    case Map.pop(state.pending_user_inputs, request_id) do
      {nil, _} ->
        {:reply, {:error, "User input request not found: #{request_id}"}, state}

      {_pending, remaining} ->
        state = %{state | pending_user_inputs: remaining}

        # Send answers back to claude process
        response =
          Jason.encode!(%{
            "type" => "user_input_response",
            "request_id" => request_id,
            "answers" => answers
          })

        send_to_port(state, response)

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
    thread = %{
      threadId: state.thread_id,
      turns:
        Enum.map(state.turns, fn t ->
          %{id: t.turn_id, items: Map.get(t, :items, [])}
        end)
    }

    {:reply, {:ok, thread}, state}
  end

  # --- Rollback ---

  @impl true
  def handle_call({:rollback_thread, num_turns}, _from, state) do
    turns =
      if num_turns > 0 do
        Enum.drop(state.turns, -num_turns)
      else
        state.turns
      end

    # Update resume state to point to the rollback target.
    # The next --resume will spawn from this point, keeping SDK state in sync.
    state = %{state | turns: turns}

    state =
      case List.last(turns) do
        nil ->
          # Rolled back to beginning — clear resume state
          %{state | last_assistant_uuid: nil}

        _last_turn ->
          # Keep existing resume_session_id; the SDK session is still valid.
          # On next send_turn, --resume will replay from the session and
          # the SDK will pick up from the correct point.
          state
      end

    thread = %{
      threadId: state.thread_id,
      turns:
        Enum.map(turns, fn t ->
          %{id: t.turn_id, items: Map.get(t, :items, [])}
        end)
    }

    {:reply, {:ok, thread}, state}
  end

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopped: true}
    emit_event(state, :session, "session/closed", %{})

    if state.port do
      try do
        Port.close(state.port)
      catch
        _, _ -> :ok
      end
    end

    cancel_all_pending(state)
    :ok
  end

  # --- Process Management ---

  defp resolve_claude_binary(opts) do
    params = Map.get(opts, :params, %{})
    provider_options = Map.get(params, "providerOptions", %{})
    claude_options = Map.get(provider_options, "claudeAgent", %{})

    Map.get(claude_options, "binaryPath") ||
      System.find_executable("claude") ||
      "claude"
  end

  defp spawn_claude_with_prompt(state, model, prompt) do
    cwd = Map.get(state.params, "cwd", File.cwd!())
    args = build_claude_args(state, model, prompt)
    spawn_claude_process(state, cwd, args)
  end

  defp spawn_claude_process(state, cwd, args) do
    # Spawn via /bin/sh -c to redirect stdin from /dev/null.
    # Claude CLI reads stdin by default; without this it waits 3s before proceeding.
    escaped_args =
      Enum.map_join([state.binary_path | args], " ", fn arg ->
        "'#{String.replace(to_string(arg), "'", "'\\''")}'"
      end)

    shell_cmd = "#{escaped_args} < /dev/null"

    try do
      port =
        Port.open(
          {:spawn_executable, ~c"/bin/sh"},
          [
            :binary,
            :exit_status,
            {:line, 1_048_576},
            {:cd, to_charlist(cwd)},
            {:args, [~c"-c", to_charlist(shell_cmd)]},
            {:env, build_env()}
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp build_claude_args(state, model, prompt) do
    args = [
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      model,
      "--verbose",
      "--include-partial-messages"
    ]

    # Add permission mode
    runtime_mode = Map.get(state.params, "runtimeMode", "approval-required")

    permission_mode =
      case runtime_mode do
        "full-access" -> "bypassPermissions"
        "plan" -> "plan"
        _ -> "default"
      end

    args = args ++ ["--permission-mode", permission_mode]

    # Add resume if available
    args =
      if state.resume_session_id do
        args ++ ["--resume", state.resume_session_id]
      else
        args ++ ["--session-id", state.session_id]
      end

    # Add max thinking tokens if set
    provider_options = Map.get(state.params, "providerOptions", %{})
    claude_options = Map.get(provider_options, "claudeAgent", %{})

    args =
      case Map.get(claude_options, "maxThinkingTokens") do
        nil -> args
        tokens -> args ++ ["--max-thinking-tokens", to_string(tokens)]
      end

    # Append prompt at the end (required for --print mode)
    if prompt do
      args ++ [prompt]
    else
      args
    end
  end

  defp build_env do
    # Pass through current environment
    System.get_env()
    |> Enum.map(fn {k, v} -> {to_charlist(k), to_charlist(v)} end)
  end

  # --- SDK Stream Processing ---

  defp process_line("", state), do: state

  defp process_line(line, state) do
    line = String.trim(line)

    if line == "" do
      state
    else
      case Jason.decode(line) do
        {:ok, msg} ->
          handle_sdk_message(msg, state)

        {:error, _} ->
          # Not JSON — could be stderr or debug output
          Logger.debug("Non-JSON claude output: #{String.slice(line, 0, 200)}")
          state
      end
    end
  end

  defp handle_sdk_message(%{"type" => "system"} = msg, state) do
    handle_system_message(msg, state)
  end

  defp handle_sdk_message(%{"type" => "assistant"} = msg, state) do
    handle_assistant_message(msg, state)
  end

  defp handle_sdk_message(%{"type" => "result"} = msg, state) do
    handle_result_message(msg, state)
  end

  defp handle_sdk_message(%{"type" => "content_block_start"} = msg, state) do
    handle_content_block_start(msg, state)
  end

  defp handle_sdk_message(%{"type" => "content_block_delta"} = msg, state) do
    handle_content_block_delta(msg, state)
  end

  defp handle_sdk_message(%{"type" => "content_block_stop"} = msg, state) do
    handle_content_block_stop(msg, state)
  end

  defp handle_sdk_message(%{"type" => "tool_use"} = msg, state) do
    handle_tool_use(msg, state)
  end

  defp handle_sdk_message(%{"type" => "permission_request"} = msg, state) do
    handle_permission_request(msg, state)
  end

  defp handle_sdk_message(%{"type" => type} = msg, state) do
    # Forward unrecognized types as raw events
    emit_event(state, :notification, type, msg)
    state
  end

  defp handle_sdk_message(_msg, state), do: state

  # --- System Messages ---

  defp handle_system_message(%{"subtype" => "init"} = msg, state) do
    session_id = get_in(msg, ["session_id"])
    state = if session_id, do: %{state | resume_session_id: session_id}, else: state

    emit_event(state, :session, "session/configured", %{
      "sessionId" => session_id,
      "model" => get_in(msg, ["model"]),
      "cwd" => get_in(msg, ["cwd"])
    })

    state
  end

  defp handle_system_message(%{"subtype" => "status", "status" => status}, state) do
    sdk_state =
      case status do
        "compacting" -> "waiting"
        _ -> "running"
      end

    emit_event(state, :session, "session/state-changed", %{"state" => sdk_state})
    state
  end

  defp handle_system_message(%{"subtype" => "compact_boundary"}, state) do
    emit_event(state, :notification, "thread/state-changed", %{"state" => "compacted"})
    state
  end

  defp handle_system_message(%{"subtype" => subtype} = msg, state)
       when subtype in [
              "hook_started",
              "hook_progress",
              "hook_response",
              "task_started",
              "task_progress",
              "task_notification"
            ] do
    emit_event(state, :notification, subtype, msg)
    state
  end

  defp handle_system_message(%{"subtype" => "files_persisted"} = msg, state) do
    emit_event(state, :notification, "files_persisted", msg)
    state
  end

  defp handle_system_message(msg, state) do
    emit_event(state, :notification, "system/unknown", msg)
    state
  end

  # --- Assistant Messages ---

  defp handle_assistant_message(msg, state) do
    # Track last assistant UUID for resume
    uuid = get_in(msg, ["message", "id"])
    state = if uuid, do: %{state | last_assistant_uuid: uuid}, else: state

    # Auto-start synthetic turn if no turn state
    state =
      if state.turn_state == nil do
        turn_id = generate_uuid()

        emit_event(state, :notification, "turn/started", %{
          "turn" => %{"id" => turn_id},
          "synthetic" => true
        })

        %{state | turn_state: %{turn_id: turn_id, started_at: now_iso(), items: []}}
      else
        state
      end

    # Emit content if present
    content = get_in(msg, ["message", "content"]) || []
    turn_id = turn_id_from_state(state)

    Enum.each(content, fn
      %{"type" => "text", "text" => text} when is_binary(text) and text != "" ->
        emit_event(state, :notification, "content/delta", %{
          "streamKind" => "assistant_text",
          "delta" => text,
          "turnId" => turn_id
        })

      %{"type" => "thinking", "thinking" => text} when is_binary(text) and text != "" ->
        emit_event(state, :notification, "content/delta", %{
          "streamKind" => "reasoning_text",
          "delta" => text,
          "turnId" => turn_id
        })

      _ ->
        :ok
    end)

    state
  end

  # --- Content Block Events ---

  defp handle_content_block_start(
         %{"content_block" => %{"type" => "tool_use"} = block} = msg,
         state
       ) do
    index = Map.get(msg, "index", 0)
    tool_name = Map.get(block, "name", "unknown")
    item_id = Map.get(block, "id", generate_uuid())
    item_type = classify_tool_item_type(tool_name)

    in_flight = %{
      item_id: item_id,
      item_type: item_type,
      tool_name: tool_name,
      partial_input_json: ""
    }

    state = put_in(state.in_flight_tools[index], in_flight)

    emit_event(state, :notification, "item/started", %{
      "itemId" => item_id,
      "itemType" => item_type,
      "toolName" => tool_name,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_content_block_start(%{"content_block" => %{"type" => "text"}}, state) do
    # Text block start — no event needed, delta events will follow
    state
  end

  defp handle_content_block_start(_msg, state), do: state

  defp handle_content_block_delta(%{"delta" => %{"type" => "text_delta", "text" => text}}, state)
       when is_binary(text) and text != "" do
    emit_event(state, :notification, "content/delta", %{
      "streamKind" => "assistant_text",
      "delta" => text,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_content_block_delta(
         %{"delta" => %{"type" => "thinking_delta", "thinking" => text}},
         state
       )
       when is_binary(text) and text != "" do
    emit_event(state, :notification, "content/delta", %{
      "streamKind" => "reasoning_text",
      "delta" => text,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_content_block_delta(
         %{"delta" => %{"type" => "input_json_delta", "partial_json" => json}, "index" => index},
         state
       ) do
    case Map.get(state.in_flight_tools, index) do
      nil ->
        state

      tool ->
        updated = %{tool | partial_input_json: tool.partial_input_json <> (json || "")}
        put_in(state.in_flight_tools[index], updated)
    end
  end

  defp handle_content_block_delta(_msg, state), do: state

  defp handle_content_block_stop(%{"index" => index}, state) do
    case Map.pop(state.in_flight_tools, index) do
      {nil, _} ->
        # Text block stop — emit assistant message completion
        emit_event(state, :notification, "item/completed", %{
          "itemType" => "assistant_message",
          "turnId" => turn_id_from_state(state)
        })

        state

      {_tool, remaining} ->
        # Tool block stop — tool execution will follow
        %{state | in_flight_tools: remaining}
    end
  end

  defp handle_content_block_stop(_msg, state), do: state

  # --- Tool Use (tool result from claude) ---

  defp handle_tool_use(%{"name" => tool_name, "input" => input} = msg, state) do
    tool_use_id = Map.get(msg, "id")
    item_type = classify_tool_item_type(tool_name)

    emit_event(state, :notification, "item/updated", %{
      "itemId" => tool_use_id,
      "itemType" => item_type,
      "toolName" => tool_name,
      "input" => input,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_tool_use(_msg, state), do: state

  # --- Permission Requests ---

  defp handle_permission_request(msg, state) do
    tool_name = Map.get(msg, "tool_name", "unknown")
    tool_input = Map.get(msg, "tool_input", %{})
    tool_use_id = Map.get(msg, "tool_use_id")

    request_id = generate_uuid()

    cond do
      tool_name == "AskUserQuestion" ->
        # User input flow
        questions = Map.get(tool_input, "questions", [])

        pending = %{
          tool_use_id: tool_use_id,
          questions: questions
        }

        state = %{
          state
          | pending_user_inputs: Map.put(state.pending_user_inputs, request_id, pending)
        }

        emit_event(state, :request, "user-input/requested", %{
          "requestId" => request_id,
          "questions" => questions
        })

        state

      tool_name == "ExitPlanMode" ->
        # Plan capture flow — deny the tool but capture the plan
        plan = Map.get(tool_input, "plan", "")

        emit_event(state, :notification, "turn/proposed-completed", %{
          "planMarkdown" => plan
        })

        # Auto-deny ExitPlanMode
        response =
          Jason.encode!(%{
            "type" => "permission_response",
            "tool_use_id" => tool_use_id,
            "behavior" => "deny",
            "message" => "The client captured your proposed plan."
          })

        send_to_port(state, response)

        state

      true ->
        # Standard approval flow
        request_type = classify_request_type(tool_name)

        pending = %{
          tool_use_id: tool_use_id,
          request_type: request_type,
          tool_name: tool_name,
          detail: extract_approval_detail(tool_input)
        }

        state = %{
          state
          | pending_approvals: Map.put(state.pending_approvals, request_id, pending)
        }

        emit_event(state, :request, "request/opened", %{
          "requestId" => request_id,
          "requestType" => request_type,
          "detail" => pending.detail,
          "args" => %{
            "toolName" => tool_name,
            "input" => tool_input,
            "toolUseId" => tool_use_id
          }
        })

        state
    end
  end

  # --- Result Messages ---

  defp handle_result_message(%{"subtype" => subtype} = msg, state) do
    status =
      case subtype do
        "success" ->
          "completed"

        "error" ->
          error_msg =
            get_in(msg, ["error", "message"]) || get_in(msg, ["error"]) || "unknown error"

          error_str = if is_binary(error_msg), do: error_msg, else: inspect(error_msg)

          cond do
            String.contains?(String.downcase(error_str), "interrupt") ->
              "interrupted"

            String.contains?(String.downcase(error_str), "cancel") ->
              "cancelled"

            true ->
              emit_event(state, :error, "runtime/error", %{
                "message" => error_str,
                "class" => "provider_error"
              })

              "failed"
          end

        _ ->
          "completed"
      end

    state = maybe_complete_turn(state, status)

    # Update usage if present
    usage = Map.get(msg, "usage")

    if usage do
      emit_event(state, :notification, "thread/token-usage-updated", usage)
    end

    state
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

    # Archive completed turn
    turns = state.turns ++ [turn]
    %{state | turn_state: nil, turns: turns}
  end

  # --- Helpers ---

  defp turn_id_from_state(%{turn_state: %{turn_id: turn_id}}), do: turn_id
  defp turn_id_from_state(_), do: nil

  defp emit_event(state, kind, method, payload) do
    event =
      Event.new(%{
        thread_id: state.thread_id,
        provider: state.provider,
        kind: kind,
        method: method,
        payload: payload
      })

    state.event_callback.(event)
  end

  defp send_to_port(%{port: port}, message) when not is_nil(port) do
    Port.command(port, message <> "\n")
  end

  defp send_to_port(_, _), do: :ok

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

  defp build_approval_response(pending, decision) do
    behavior =
      case decision do
        "accept" -> "allow"
        "acceptForSession" -> "allow"
        "allow" -> "allow"
        _ -> "deny"
      end

    Jason.encode!(%{
      "type" => "permission_response",
      "tool_use_id" => Map.get(pending, :tool_use_id),
      "behavior" => behavior,
      "message" => if(behavior == "deny", do: "User denied", else: nil)
    })
  end

  defp cancel_all_pending(state) do
    # Cancel pending approvals
    Enum.each(state.pending_approvals, fn {request_id, _pending} ->
      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id,
        "decision" => "cancel"
      })
    end)

    # Cancel pending user inputs
    Enum.each(state.pending_user_inputs, fn {request_id, _pending} ->
      emit_event(state, :notification, "user-input/resolved", %{
        "requestId" => request_id,
        "answers" => %{}
      })
    end)

    %{state | pending_approvals: %{}, pending_user_inputs: %{}}
  end

  defp parse_resume_state(state) do
    resume_cursor = get_in(state.params, ["resumeCursor"])

    case resume_cursor do
      nil ->
        state

      cursor when is_binary(cursor) ->
        case Jason.decode(cursor) do
          {:ok, %{"resume" => resume_id} = parsed} ->
            %{
              state
              | resume_session_id: resume_id,
                last_assistant_uuid: Map.get(parsed, "resumeSessionAt")
            }

          _ ->
            state
        end

      %{"resume" => resume_id} = cursor ->
        %{
          state
          | resume_session_id: resume_id,
            last_assistant_uuid: Map.get(cursor, "resumeSessionAt")
        }

      _ ->
        state
    end
  end

  defp build_resume_cursor(state) do
    Jason.encode!(%{
      "threadId" => state.thread_id,
      "resume" => state.resume_session_id || state.session_id,
      "resumeSessionAt" => state.last_assistant_uuid,
      "turnCount" => length(state.turns)
    })
  end

  defp classify_tool_item_type(tool_name) do
    name = String.downcase(tool_name)

    cond do
      String.contains?(name, "agent") or String.contains?(name, "task") or
          String.contains?(name, "subagent") ->
        "collab_agent_tool_call"

      String.contains?(name, "bash") or String.contains?(name, "command") or
        String.contains?(name, "shell") or String.contains?(name, "terminal") ->
        "command_execution"

      String.contains?(name, "edit") or String.contains?(name, "write") or
        String.contains?(name, "file") or String.contains?(name, "patch") ->
        "file_change"

      String.contains?(name, "mcp") ->
        "mcp_tool_call"

      String.contains?(name, "web") and String.contains?(name, "search") ->
        "web_search"

      String.contains?(name, "image") ->
        "image_view"

      true ->
        "dynamic_tool_call"
    end
  end

  defp classify_request_type(tool_name) do
    name = String.downcase(tool_name)

    cond do
      String.contains?(name, "read") or String.contains?(name, "view") or
        String.contains?(name, "grep") or String.contains?(name, "glob") or
          String.contains?(name, "search") ->
        "file_read_approval"

      String.contains?(name, "bash") or String.contains?(name, "command") or
          String.contains?(name, "shell") ->
        "command_execution_approval"

      String.contains?(name, "edit") or String.contains?(name, "write") or
        String.contains?(name, "file") or String.contains?(name, "patch") ->
        "file_change_approval"

      true ->
        "dynamic_tool_call"
    end
  end

  defp extract_approval_detail(input) do
    Map.get(input, "command") ||
      Map.get(input, "file_path") ||
      Map.get(input, "path") ||
      Map.get(input, "prompt") ||
      nil
  end

  defp generate_uuid do
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

  defp split_lines(buffer) do
    case String.split(buffer, "\n") do
      [single] ->
        {[], single}

      parts ->
        {lines, [remaining]} = Enum.split(parts, -1)
        {lines, remaining}
    end
  end
end
