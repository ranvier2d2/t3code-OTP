defmodule Harness.Providers.CursorSession do
  @moduledoc """
  GenServer managing a single Cursor Agent session.

  Cursor Agent CLI uses the same stream-json protocol as Claude CLI:
  - `cursor agent --print --output-format stream-json --force <prompt>`
  - Spawns a new process per turn (like ClaudeSession)
  - Parses stdout JSON stream: system/init, thinking/delta, assistant, result
  - Multi-turn via --resume flag
  """
  use GenServer, restart: :temporary
  @behaviour Harness.ProviderSession

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
    :binary_path,
    turn_state: nil,
    pending_approvals: %{},
    turns: [],
    stopped: false,
    reasoning_item_id: nil,
    has_real_chat_id: false
  ]

  # --- Public API ---

  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, "cursor"}}
    )
  end

  def send_turn(pid, params) do
    GenServer.call(pid, {:send_turn, params}, 60_000)
  end

  def interrupt_turn(pid, _thread_id, _turn_id) do
    GenServer.call(pid, :interrupt_turn, 30_000)
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

  def rollback_thread(_pid, _thread_id, _num_turns) do
    {:error, "Rollback not supported for Cursor provider"}
  end

  def wait_for_ready(_pid, _timeout \\ 30_000) do
    # Cursor is ready immediately — spawns process on send_turn, not in init.
    :ok
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    params = Map.get(opts, :params, %{})
    binary_path = resolve_cursor_binary(opts)

    # Restore session from resumeCursor, or create a new Cursor chat
    resume_session_id = extract_resume_session_id(params)
    cursor_chat_id = resume_session_id || create_cursor_chat(binary_path)

    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "cursor",
      event_callback: Map.fetch!(opts, :event_callback),
      params: params,
      buffer: "",
      binary_path: binary_path,
      session_id: cursor_chat_id || generate_id(),
      resume_session_id: resume_session_id,
      has_real_chat_id: cursor_chat_id != nil
    }

    # Don't spawn cursor yet — spawn on first send_turn with the actual prompt.
    emit_event(state, :session, "session/started", %{
      "model" => Map.get(state.params, "model"),
      "cwd" => Map.get(state.params, "cwd"),
      "cursorChatId" => state.session_id
    })

    emit_event(state, :session, "session/ready", %{})
    persist_binding(state)

    {:ok, state}
  end

  # Port data received (stdout from cursor process)
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

  # Port exit — cursor spawns a new process per turn, so a normal exit
  # just means the turn finished. Keep the GenServer alive for multi-turn.
  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    state =
      if state.stopped do
        state
      else
        Logger.info(
          "Cursor Agent process exited with status #{status} for thread #{state.thread_id}"
        )

        maybe_complete_turn(state, if(status == 0, do: "completed", else: "failed"))
      end

    # Clear the port ref but keep the GenServer alive for subsequent turns.
    # The resume_session_id captured from system/init enables --resume on next turn.
    {:noreply, %{state | port: nil}}
  end

  # Raw binary data fallback
  @impl true
  def handle_info({port, {:data, data}}, %{port: port} = state) when is_binary(data) do
    buffer = state.buffer <> data
    {lines, remaining} = split_lines(buffer)
    state = %{state | buffer: remaining}
    state = Enum.reduce(lines, state, &process_line/2)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state) do
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
      has_real_chat_id: state.has_real_chat_id,
      reasoning_item_id: state.reasoning_item_id,
      port_alive: DH.port_alive?(state.port),
      turn_state: DH.sanitize_turn_state(state.turn_state),
      pending_approvals_count: map_size(state.pending_approvals),
      turn_count: length(state.turns),
      buffer_bytes: byte_size(state.buffer || "")
    }

    {:reply, {:ok, diagnostics}, state}
  end

  # --- Send Turn ---

  @impl true
  def handle_call({:send_turn, params}, _from, state) do
    # Auto-complete any stale turn and kill previous process.
    # Wait for exit_status to avoid stale events leaking into the new turn.
    state = maybe_complete_turn(state, "completed")

    state =
      if state.port do
        try do
          Port.close(state.port)
        catch
          _, _ -> :ok
        end

        # Drain any pending exit_status message from the closed port
        receive do
          {_, {:exit_status, _}} -> :ok
        after
          500 -> :ok
        end

        %{state | port: nil}
      else
        state
      end

    turn_id = generate_id()
    input = Map.get(params, "input", [])
    text = extract_text(input)

    turn_state = %{
      turn_id: turn_id,
      started_at: now_iso(),
      items: []
    }

    state = %{state | turn_state: turn_state, reasoning_item_id: nil}

    # Emit running state so the sidebar shows "Working" badge
    emit_event(state, :session, "session/state-changed", %{"state" => "running"})

    emit_event(state, :notification, "turn/started", %{
      "turn" => %{"id" => turn_id},
      "model" => Map.get(params, "model", Map.get(state.params, "model"))
    })

    # Spawn cursor agent with --print and the prompt as argument
    model = Map.get(params, "model", Map.get(state.params, "model"))

    case spawn_cursor_with_prompt(state, model, text) do
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
        Logger.error("Failed to spawn cursor agent: #{inspect(reason)}")
        state = maybe_complete_turn(state, "failed")

        emit_event(state, :error, "runtime/error", %{
          "message" => "Failed to spawn cursor agent: #{inspect(reason)}",
          "class" => "spawn_error"
        })

        {:reply, {:error, %{reason: inspect(reason)}}, state}
    end
  end

  # --- Interrupt ---

  @impl true
  def handle_call(:interrupt_turn, _from, state) do
    if state.port do
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

        behavior =
          case decision do
            "accept" -> "allow"
            "acceptForSession" -> "allow"
            "allow" -> "allow"
            _ -> "deny"
          end

        response =
          Jason.encode!(%{
            "type" => "permission_response",
            "tool_use_id" => Map.get(pending, :tool_use_id),
            "behavior" => behavior,
            "message" => if(behavior == "deny", do: "User denied", else: nil)
          })

        send_to_port(state, response)

        emit_event(state, :notification, "request/resolved", %{
          "requestId" => request_id,
          "decision" => decision
        })

        {:reply, :ok, state}
    end
  end

  # --- User Input ---

  @impl true
  def handle_call({:respond_to_user_input, _request_id, _answers}, _from, state) do
    {:reply, {:error, "User input not supported for Cursor"}, state}
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

  @impl true
  def terminate(_reason, %{port: port} = state) do
    # Set stopped flag first — handle_info checks it before processing exit_status.
    # Since terminate runs in the same process as handle_info, the flag is visible
    # to any messages processed after Port.close sends the exit notification.
    state = %{state | stopped: true}
    maybe_complete_turn(state, "completed")
    cancel_all_pending(state)
    emit_event(state, :session, "session/closed", %{})

    if port do
      try do
        Port.close(port)
      catch
        _, _ -> :ok
      end
    end

    :ok
  end

  defp cancel_all_pending(state) do
    Enum.each(state.pending_approvals, fn {request_id, _pending} ->
      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id,
        "decision" => "cancel"
      })
    end)

    # Cursor doesn't have separate user-input tracking, but cancel anything remaining
  end

  # --- Session Creation & Recovery ---

  # Parse resumeCursor JSON to extract the Cursor chatId for --resume
  defp extract_resume_session_id(params) do
    case get_in(params, ["resumeCursor"]) do
      nil ->
        nil

      cursor when is_binary(cursor) ->
        case Jason.decode(cursor) do
          {:ok, %{"cursorChatId" => chat_id}} when is_binary(chat_id) -> chat_id
          # Legacy format compatibility
          {:ok, %{"resume" => chat_id}} when is_binary(chat_id) -> chat_id
          _ -> nil
        end

      _ ->
        nil
    end
  end

  # Call `cursor agent create-chat` to get a real Cursor chatId.
  # This enables thread persistence — the chatId can be used with --resume
  # to continue conversations across T3Code restarts.
  defp create_cursor_chat(binary_path) do
    try do
      {output, 0} = System.cmd(binary_path, ["agent", "create-chat"], stderr_to_stdout: true)
      chat_id = String.trim(output)

      if String.match?(chat_id, ~r/^[0-9a-f-]+$/i) do
        Logger.info("Created Cursor chat: #{chat_id}")
        chat_id
      else
        Logger.warning("Unexpected create-chat output: #{String.slice(output, 0, 100)}")
        nil
      end
    rescue
      e ->
        Logger.warning("Failed to create Cursor chat: #{Exception.message(e)}")
        nil
    catch
      _, _ -> nil
    end
  end

  # --- Process Management ---

  defp resolve_cursor_binary(opts) do
    params = Map.get(opts, :params, %{})
    provider_options = Map.get(params, "providerOptions", %{})
    cursor_options = Map.get(provider_options, "cursor", %{})

    Map.get(cursor_options, "binaryPath") ||
      System.find_executable("cursor") ||
      "cursor"
  end

  defp spawn_cursor_with_prompt(state, model, prompt) do
    cwd = Map.get(state.params, "cwd", File.cwd!())
    args = build_cursor_args(state, model, prompt)
    spawn_cursor_process(state, cwd, args)
  end

  defp spawn_cursor_process(state, cwd, args) do
    try do
      port =
        Port.open(
          {:spawn_executable, to_charlist(state.binary_path)},
          [
            :binary,
            :exit_status,
            {:line, 1_048_576},
            {:cd, to_charlist(cwd)},
            {:args, Enum.map(args, &to_charlist/1)},
            {:env, build_env()}
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp build_cursor_args(state, model, prompt) do
    cursor_opts = get_in(state.params, ["providerOptions", "cursor"]) || %{}

    args = [
      "agent",
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--approve-mcps",
      "--yolo"
    ]

    # Execution mode: --mode plan|ask
    args =
      case Map.get(cursor_opts, "mode") do
        mode when mode in ["plan", "ask"] -> args ++ ["--mode", mode]
        _ -> args
      end

    # Add model if specified
    args =
      if model do
        args ++ ["--model", model]
      else
        args
      end

    # Add workspace if specified
    args =
      case Map.get(state.params, "cwd") do
        nil -> args
        cwd -> args ++ ["--workspace", cwd]
      end

    # Resume: only use --resume with a real Cursor chatId (from create-chat,
    # system/init, or resumeCursor). Never pass a synthetic generate_id() value.
    chat_id = state.resume_session_id || (state.has_real_chat_id && state.session_id)

    args =
      if is_binary(chat_id) do
        args ++ ["--resume", chat_id]
      else
        args
      end

    # Append prompt at the end
    if prompt do
      args ++ [prompt]
    else
      args
    end
  end

  defp build_env do
    System.get_env()
    |> Enum.map(fn {k, v} -> {to_charlist(k), to_charlist(v)} end)
  end

  # --- Stream-JSON Processing (same as Claude CLI) ---

  defp process_line("", state), do: state

  defp process_line(line, state) do
    line = String.trim(line)

    if line == "" do
      state
    else
      case Jason.decode(line) do
        {:ok, msg} ->
          handle_stream_message(msg, state)

        {:error, _} ->
          Logger.debug("Non-JSON cursor output: #{String.slice(line, 0, 200)}")
          state
      end
    end
  end

  defp handle_stream_message(%{"type" => "system", "subtype" => "init"} = msg, state) do
    session_id = Map.get(msg, "session_id")
    state = if session_id, do: %{state | resume_session_id: session_id}, else: state

    emit_event(state, :session, "session/configured", %{
      "sessionId" => session_id,
      "model" => Map.get(msg, "model"),
      "cwd" => Map.get(msg, "cwd")
    })

    state
  end

  defp handle_stream_message(%{"type" => "thinking", "subtype" => "delta", "text" => text}, state)
       when is_binary(text) and text != "" do
    # Emit item/started on the first reasoning delta to create a proper lifecycle
    state =
      if state.reasoning_item_id == nil do
        item_id = generate_id()

        emit_event(state, :notification, "item/started", %{
          "itemId" => item_id,
          "itemType" => "reasoning",
          "toolName" => "Thinking",
          "turnId" => turn_id_from_state(state)
        })

        %{state | reasoning_item_id: item_id}
      else
        state
      end

    emit_event(state, :notification, "content/delta", %{
      "streamKind" => "reasoning_text",
      "delta" => text,
      "itemId" => state.reasoning_item_id,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_stream_message(%{"type" => "thinking", "subtype" => "completed"}, state) do
    if state.reasoning_item_id do
      emit_event(state, :notification, "item/completed", %{
        "itemId" => state.reasoning_item_id,
        "itemType" => "reasoning",
        "toolName" => "Thinking",
        "status" => "completed",
        "turnId" => turn_id_from_state(state)
      })

      %{state | reasoning_item_id: nil}
    else
      state
    end
  end

  # Cursor sends two "assistant" events: one with timestamp_ms (streaming delta)
  # and one without (final snapshot). Only emit the first to avoid duplicate text.
  defp handle_stream_message(%{"type" => "assistant", "timestamp_ms" => _} = msg, state) do
    content = get_in(msg, ["message", "content"]) || []
    turn_id = turn_id_from_state(state)

    Enum.each(content, fn
      %{"type" => "text", "text" => text} when is_binary(text) and text != "" ->
        emit_event(state, :notification, "content/delta", %{
          "streamKind" => "assistant_text",
          "delta" => text,
          "turnId" => turn_id
        })

      _ ->
        :ok
    end)

    state
  end

  # Skip the duplicate assistant message without timestamp_ms (final snapshot)
  defp handle_stream_message(%{"type" => "assistant"}, state), do: state

  defp handle_stream_message(%{"type" => "result", "subtype" => subtype} = msg, state) do
    status =
      case subtype do
        "success" ->
          "completed"

        "error" ->
          error_msg =
            get_in(msg, ["error", "message"]) || get_in(msg, ["error"]) || "unknown error"

          error_str = if is_binary(error_msg), do: error_msg, else: inspect(error_msg)

          emit_event(state, :error, "runtime/error", %{
            "message" => error_str,
            "class" => "provider_error",
            "provider" => "cursor"
          })

          "failed"

        _ ->
          "completed"
      end

    state = maybe_complete_turn(state, status)

    # Emit usage if present
    duration = Map.get(msg, "duration_ms")

    if duration do
      emit_event(state, :notification, "thread/token-usage-updated", %{
        "duration_ms" => duration
      })
    end

    state
  end

  defp handle_stream_message(%{"type" => "user"}, state), do: state

  # --- Tool Call Lifecycle ---
  # Cursor emits {"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{...}}
  # Map these to item/started and item/completed so the chat view shows tool activity.

  defp handle_stream_message(%{"type" => "tool_call", "subtype" => "started"} = msg, state) do
    call_id = Map.get(msg, "call_id", generate_id())
    tool_call = Map.get(msg, "tool_call", %{})
    {item_type, tool_name, detail} = classify_cursor_tool(tool_call)

    emit_event(state, :notification, "item/started", %{
      "itemId" => call_id,
      "itemType" => item_type,
      "toolName" => tool_name,
      "detail" => detail,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_stream_message(%{"type" => "tool_call", "subtype" => "completed"} = msg, state) do
    call_id = Map.get(msg, "call_id", generate_id())
    tool_call = Map.get(msg, "tool_call", %{})
    {item_type, tool_name, _detail} = classify_cursor_tool(tool_call)

    # Extract result status
    status =
      cond do
        get_in(tool_call, [tool_call_key(tool_call), "result", "success"]) -> "completed"
        get_in(tool_call, [tool_call_key(tool_call), "result", "error"]) -> "failed"
        true -> "completed"
      end

    # Extract output for content delta (command stdout/stderr)
    result = get_in(tool_call, [tool_call_key(tool_call), "result", "success"]) || %{}
    output = Map.get(result, "stdout") || Map.get(result, "interleavedOutput") || ""

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
        "turnId" => turn_id_from_state(state)
      })
    end

    emit_event(state, :notification, "item/completed", %{
      "itemId" => call_id,
      "itemType" => item_type,
      "toolName" => tool_name,
      "status" => status,
      "turnId" => turn_id_from_state(state)
    })

    state
  end

  defp handle_stream_message(%{"type" => "permission_request"} = msg, state) do
    tool_name = Map.get(msg, "tool_name", "unknown")
    tool_input = Map.get(msg, "tool_input", %{})
    tool_use_id = Map.get(msg, "tool_use_id")

    request_id = generate_id()

    pending = %{
      tool_use_id: tool_use_id,
      tool_name: tool_name
    }

    state = %{state | pending_approvals: Map.put(state.pending_approvals, request_id, pending)}

    emit_event(state, :request, "request/opened", %{
      "requestId" => request_id,
      "requestType" => "dynamic_tool_call",
      "detail" => tool_name,
      "args" => %{
        "toolName" => tool_name,
        "input" => tool_input,
        "toolUseId" => tool_use_id
      }
    })

    state
  end

  defp handle_stream_message(%{"type" => type} = msg, state) do
    emit_event(state, :notification, type, msg)
    state
  end

  defp handle_stream_message(_msg, state), do: state

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

    # Emit ready state so the sidebar clears the "Working" badge
    emit_event(state, :session, "session/state-changed", %{"state" => "ready"})

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

  defp extract_text(input) when is_list(input) do
    Enum.map_join(input, "\n", fn
      %{"type" => "text", "text" => text} -> text
      %{"text" => text} -> text
      item when is_binary(item) -> item
      _ -> ""
    end)
  end

  defp extract_text(input) when is_binary(input), do: input
  defp extract_text(_), do: ""

  defp build_resume_cursor(state) do
    # Store the real Cursor chatId so the orchestration layer can persist it.
    # On session recovery, this chatId is passed back via resumeCursor → --resume.
    Jason.encode!(%{
      "threadId" => state.thread_id,
      "cursorChatId" => state.resume_session_id || state.session_id,
      "turnCount" => length(state.turns)
    })
  end

  defp persist_binding(state) do
    cursor_json = build_resume_cursor(state)
    Harness.Storage.upsert_binding(state.thread_id, state.provider, cursor_json)
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

  # --- Cursor Tool Classification ---
  # Maps Cursor's tool_call payload keys to canonical item types.
  # Cursor uses {"shellToolCall": ...}, {"fileEditToolCall": ...}, etc.

  @cursor_tool_types %{
    "shellToolCall" => {"command_execution", "shell"},
    "fileEditToolCall" => {"file_change", "file_edit"},
    "fileReadToolCall" => {"file_change", "file_read"},
    "listDirToolCall" => {"command_execution", "list_dir"},
    "searchToolCall" => {"web_search", "search"},
    "mcpToolCall" => {"mcp_tool_call", "mcp"},
    "codebaseSearchToolCall" => {"web_search", "codebase_search"},
    "grepToolCall" => {"command_execution", "grep"},
    "deleteFileToolCall" => {"file_change", "delete_file"},
    "renameFileToolCall" => {"file_change", "rename_file"},
    "createFileToolCall" => {"file_change", "create_file"}
  }

  defp classify_cursor_tool(tool_call) when is_map(tool_call) do
    # First try known tool types
    case Enum.find_value(@cursor_tool_types, fn {key, {item_type, tool_name}} ->
           case Map.get(tool_call, key) do
             nil ->
               nil

             inner ->
               detail = extract_tool_detail(key, inner)
               {item_type, tool_name, detail}
           end
         end) do
      nil ->
        # Fallback: auto-detect any key ending in "ToolCall" and derive a human name
        case Enum.find(Map.keys(tool_call), &String.ends_with?(&1, "ToolCall")) do
          nil ->
            Logger.warning("Unclassified Cursor tool_call keys: #{inspect(Map.keys(tool_call))}")
            {"dynamic_tool_call", "tool", nil}

          key ->
            # "readDirectoryToolCall" → "read_directory"
            human_name =
              key
              |> String.replace_trailing("ToolCall", "")
              |> Macro.underscore()
              |> String.replace("_", " ")

            inner = Map.get(tool_call, key, %{})
            detail = extract_tool_detail(key, inner)
            Logger.info("Auto-classified Cursor tool: #{key} → #{human_name}")
            {"dynamic_tool_call", human_name, detail}
        end

      result ->
        result
    end
  end

  defp classify_cursor_tool(_), do: {"dynamic_tool_call", "tool", nil}

  defp tool_call_key(tool_call) when is_map(tool_call) do
    # Try known types first, then any key ending in "ToolCall"
    Enum.find_value(Map.keys(@cursor_tool_types), fn key ->
      if Map.has_key?(tool_call, key), do: key
    end) || Enum.find(Map.keys(tool_call), &String.ends_with?(&1, "ToolCall"))
  end

  defp tool_call_key(_), do: nil

  defp extract_tool_detail("shellToolCall", inner) do
    get_in(inner, ["args", "command"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail("fileEditToolCall", inner) do
    get_in(inner, ["args", "filePath"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail("fileReadToolCall", inner) do
    get_in(inner, ["args", "filePath"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail("createFileToolCall", inner) do
    get_in(inner, ["args", "filePath"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail("deleteFileToolCall", inner) do
    get_in(inner, ["args", "filePath"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail("renameFileToolCall", inner) do
    get_in(inner, ["args", "filePath"]) || get_in(inner, ["description"])
  end

  defp extract_tool_detail(_, inner) do
    Map.get(inner, "description") || Map.get(inner, "query")
  end
end
