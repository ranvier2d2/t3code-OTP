defmodule Harness.Providers.AcpSession do
  @moduledoc """
  GenServer managing a single Cursor ACP session over JSON-RPC 2.0.
  """
  @behaviour Harness.Providers.ProviderBehaviour

  use GenServer, restart: :temporary

  alias Harness.Event
  alias Harness.JsonRpc

  require Logger

  @request_timeout 20_000
  @handshake_timeout 20_000

  defstruct [
    :thread_id,
    :provider,
    :port,
    :event_callback,
    :params,
    :binary_path,
    :buffer,
    :acp_session_id,
    :agent_capabilities,
    :auth_methods,
    :ready_timer,
    :current_turn_id,
    :current_prompt_rpc_id,
    :reasoning_item_id,
    next_id: 1,
    status: :initializing,
    ready_waiters: [],
    pending: %{},
    tool_items: MapSet.new(),
    turns: [],
    stopped: false
  ]

  @impl Harness.Providers.ProviderBehaviour
  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, "cursor"}}
    )
  end

  @impl Harness.Providers.ProviderBehaviour
  def wait_for_ready(pid, timeout \\ 30_000) do
    GenServer.call(pid, :wait_for_ready, timeout)
  end

  @impl Harness.Providers.ProviderBehaviour
  def send_turn(pid, params) do
    GenServer.call(pid, {:send_turn, params}, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def interrupt_turn(pid, thread_id, turn_id) do
    GenServer.call(pid, {:interrupt_turn, thread_id, turn_id}, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def respond_to_approval(pid, request_id, decision) do
    GenServer.call(pid, {:respond_to_approval, request_id, decision}, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def respond_to_user_input(pid, request_id, answers) do
    GenServer.call(pid, {:respond_to_user_input, request_id, answers}, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def read_thread(pid, _thread_id) do
    GenServer.call(pid, :read_thread, 30_000)
  end

  @impl Harness.Providers.ProviderBehaviour
  def rollback_thread(_pid, _thread_id, _num_turns) do
    {:error, "Rollback not supported for Cursor ACP provider"}
  end

  @impl Harness.Providers.ProviderBehaviour
  def stop(pid), do: GenServer.stop(pid, :normal)

  @impl true
  def init(opts) do
    params = Map.get(opts, :params, %{})
    binary_path = resolve_cursor_binary(opts)

    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "cursor",
      event_callback: Map.fetch!(opts, :event_callback),
      params: params,
      binary_path: binary_path,
      buffer: ""
    }

    emit_event(state, :session, "session/started", %{
      "cwd" => Map.get(params, "cwd"),
      "model" => Map.get(params, "model"),
      "protocol" => "acp"
    })

    case spawn_cursor_acp(state) do
      {:ok, port} ->
        timer = Process.send_after(self(), :handshake_timeout, @handshake_timeout)
        send(self(), :initialize)
        {:ok, %{state | port: port, ready_timer: timer}}

      {:error, reason} ->
        emit_event(state, :error, "runtime/error", %{
          "message" => "Failed to spawn Cursor ACP: #{reason}",
          "class" => "provider_startup_error",
          "provider" => "cursor"
        })

        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:initialize, state) do
    {id, state} = next_request_id(state)

    params = %{
      "protocolVersion" => 1,
      "clientCapabilities" => %{
        "fs" => %{"readTextFile" => false, "writeTextFile" => false},
        "terminal" => false
      },
      "clientInfo" => %{"name" => "t3-harness", "version" => "0.1.0"}
    }

    {:noreply, send_rpc_request(state, id, "initialize", params)}
  end

  @impl true
  def handle_info(:handshake_timeout, state) do
    if ready?(state) do
      {:noreply, state}
    else
      Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, :handshake_timeout}))

      emit_event(state, :error, "runtime/error", %{
        "message" => "Cursor ACP handshake timed out",
        "class" => "provider_startup_error",
        "provider" => "cursor"
      })

      {:stop, :handshake_timeout, reject_all_pending(state, "Handshake timeout")}
    end
  end

  @impl true
  def handle_info({:request_timeout, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        {:noreply, state}

      {%{from: from}, pending} ->
        if from, do: GenServer.reply(from, {:error, "Request timeout"})
        {:noreply, %{state | pending: pending}}
    end
  end

  @impl true
  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    full_line = state.buffer <> to_string(line)

    case process_line(full_line, %{state | buffer: ""}) do
      {:continue, state} -> {:noreply, state}
      {:stop, reason, state} -> {:stop, reason, state}
    end
  end

  @impl true
  def handle_info({port, {:data, {:noeol, chunk}}}, %{port: port} = state) do
    {:noreply, %{state | buffer: state.buffer <> to_string(chunk)}}
  end

  @impl true
  def handle_info({port, {:data, data}}, %{port: port} = state) when is_binary(data) do
    buffer = state.buffer <> data
    {lines, remaining} = split_lines(buffer)
    state = %{state | buffer: remaining}

    case reduce_lines(lines, state) do
      {:continue, state} -> {:noreply, state}
      {:stop, reason, state} -> {:stop, reason, state}
    end
  end

  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    unless state.stopped do
      emit_event(state, :session, "session/exited", %{
        "exitStatus" => status,
        "exitKind" => if(status == 0, do: "graceful", else: "error")
      })
    end

    state = reject_all_pending(state, "Process exited")
    {:stop, :normal, %{state | port: nil}}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:wait_for_ready, _from, state) when state.status == :ready do
    {:reply, :ok, state}
  end

  @impl true
  def handle_call(:wait_for_ready, from, state) do
    {:noreply, %{state | ready_waiters: [from | state.ready_waiters]}}
  end

  @impl true
  def handle_call(
        {:send_turn, params},
        from,
        %{status: :ready, acp_session_id: session_id} = state
      )
      when is_binary(session_id) do
    text = extract_text(Map.get(params, "input", []))
    turn_id = generate_id()

    emit_event(state, :session, "session/state-changed", %{"state" => "running"})

    emit_event(state, :notification, "turn/started", %{
      "turn" => %{"id" => turn_id},
      "model" => Map.get(params, "model", Map.get(state.params, "model"))
    })

    {id, state} = next_request_id(state)

    state =
      state
      |> Map.put(:current_turn_id, turn_id)
      |> Map.put(:current_prompt_rpc_id, id)
      |> Map.put(:status, :prompting)
      |> send_rpc_request(
        id,
        "session/prompt",
        %{
          "sessionId" => session_id,
          "prompt" => [%{"type" => "text", "text" => text}]
        },
        from
      )

    {:noreply, state}
  end

  @impl true
  def handle_call({:send_turn, _params}, _from, state) do
    {:reply, {:error, "Session not ready"}, state}
  end

  @impl true
  def handle_call({:interrupt_turn, _thread_id, _turn_id}, _from, %{current_turn_id: nil} = state) do
    {:reply, {:error, "No active turn"}, state}
  end

  @impl true
  def handle_call({:interrupt_turn, _thread_id, _turn_id}, _from, state) do
    send_to_port(
      state,
      JsonRpc.encode_notification("session/cancel", %{"sessionId" => state.acp_session_id})
    )

    state = complete_turn(state, "interrupted")
    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:respond_to_approval, request_id, decision}, _from, state) do
    case find_pending_provider_request(state, request_id, "session/request_permission") do
      {rpc_id, _entry} ->
        send_to_port(state, JsonRpc.encode_response(rpc_id, %{"decision" => decision}))

        emit_event(state, :notification, "request/resolved", %{
          "requestId" => request_id,
          "decision" => decision
        })

        {:reply, :ok, remove_pending(state, rpc_id)}

      nil ->
        {:reply, {:error, "Approval request not found: #{request_id}"}, state}
    end
  end

  @impl true
  def handle_call({:respond_to_user_input, request_id, answers}, _from, state) do
    case find_pending_provider_request(state, request_id, "session/elicitation") do
      {rpc_id, _entry} ->
        send_to_port(state, JsonRpc.encode_response(rpc_id, answers))

        emit_event(state, :notification, "user-input/resolved", %{
          "requestId" => request_id,
          "answers" => answers
        })

        {:reply, :ok, remove_pending(state, rpc_id)}

      nil ->
        {:reply, {:error, "User input request not found: #{request_id}"}, state}
    end
  end

  @impl true
  def handle_call(:read_thread, _from, state) do
    turns =
      Enum.map(state.turns, fn turn ->
        %{id: turn.turn_id, items: Map.get(turn, :items, [])}
      end)

    {:reply, {:ok, %{threadId: state.thread_id, turns: turns}}, state}
  end

  @impl true
  def handle_call(:get_diagnostics, _from, state) do
    diagnostics = %{
      thread_id: state.thread_id,
      provider: state.provider,
      acp_session_id: state.acp_session_id,
      binary_path: state.binary_path,
      status: state.status,
      current_turn_id: state.current_turn_id,
      pending_count: map_size(state.pending),
      tool_item_count: MapSet.size(state.tool_items),
      ready: ready?(state)
    }

    {:reply, {:ok, diagnostics}, state}
  end

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopped: true}
    _ = reject_all_pending(state, "Session terminated")
    emit_event(state, :session, "session/closed", %{})

    if state.port do
      try do
        Port.close(state.port)
      catch
        _, _ -> :ok
      end
    end

    :ok
  end

  defp process_line("", state), do: {:continue, state}

  defp process_line(line, state) do
    case JsonRpc.decode(String.trim(line)) do
      {:request, id, method, params} ->
        {:continue, handle_rpc_request(state, id, method, params)}

      {:notification, method, params} ->
        {:continue, handle_rpc_notification(state, method, params)}

      {:response, id, result} ->
        handle_rpc_response(state, id, result)

      {:error_response, id, cause} ->
        handle_rpc_error(state, id, cause)

      {:error, reason} ->
        Logger.warning("Failed to decode ACP frame: #{inspect(reason)}")
        {:continue, state}
    end
  end

  defp handle_rpc_response(state, id, result) do
    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        {:continue, state}

      {%{from: nil, method: "initialize"}, pending} ->
        methods = Map.get(result, "authMethods", [])
        method_id = pick_auth_method(methods)

        state = %{
          state
          | pending: pending,
            agent_capabilities: result["agentCapabilities"],
            auth_methods: methods
        }

        if method_id do
          {next_id, state} = next_request_id(%{state | status: :authenticating})

          {:continue,
           send_rpc_request(state, next_id, "authenticate", %{"methodId" => method_id})}
        else
          stop_startup(state, "Cursor ACP did not advertise an auth method")
        end

      {%{from: nil, method: "authenticate"}, pending} ->
        state = %{state | pending: pending, status: :creating_session}
        {:continue, bootstrap_session(state)}

      {%{from: nil, method: method}, pending}
      when method in ["session/new", "session/load"] ->
        session_id = Map.get(result, "sessionId") || state.acp_session_id

        state =
          state
          |> Map.put(:pending, pending)
          |> Map.put(:acp_session_id, session_id)
          |> Map.put(:status, :ready)
          |> maybe_cancel_ready_timer()

        persist_binding(state)
        emit_event(state, :session, "session/ready", %{})
        {:continue, wake_ready_waiters(state)}

      {%{from: from, timer: timer, method: "session/prompt"}, pending} ->
        if timer, do: Process.cancel_timer(timer)

        if from,
          do:
            GenServer.reply(
              from,
              {:ok, %{threadId: state.thread_id, turnId: state.current_turn_id}}
            )

        state
        |> Map.put(:pending, pending)
        |> complete_turn("completed", %{"stopReason" => prompt_stop_reason(result)})
        |> then(&{:continue, &1})

      {%{from: from, timer: timer}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        if from, do: GenServer.reply(from, {:ok, result})
        {:continue, %{state | pending: pending}}
    end
  end

  defp handle_rpc_error(state, id, cause) do
    error = extract_error(cause)

    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        {:continue, state}

      {%{from: nil, method: "session/load"}, pending} ->
        state = %{state | pending: pending}

        Logger.warning(
          "Cursor ACP session/load failed, falling back to session/new: #{inspect(error)}"
        )

        Harness.Storage.delete_binding(state.thread_id)
        {:continue, send_new_session_request(state)}

      {%{from: nil, method: method}, pending}
      when method in ["initialize", "authenticate", "session/new"] ->
        state = %{state | pending: pending}
        stop_startup(state, Map.get(error, "message", "ACP startup failed"))

      {%{from: from, timer: timer, method: "session/prompt"}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        if from, do: GenServer.reply(from, {:error, Map.get(error, "message", "Prompt failed")})

        emit_event(state, :error, "runtime/error", %{
          "message" => Map.get(error, "message", "Prompt failed"),
          "class" => "provider_error",
          "provider" => "cursor",
          "code" => Map.get(error, "code")
        })

        state
        |> Map.put(:pending, pending)
        |> complete_turn(prompt_failure_status(error))
        |> then(&{:continue, &1})

      {%{from: from, timer: timer}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        if from, do: GenServer.reply(from, {:error, Map.get(error, "message", "Request failed")})
        {:continue, %{state | pending: pending}}
    end
  end

  defp handle_rpc_request(state, id, "session/request_permission", params) do
    request_id = Map.get(params, "requestId", "rpc-#{id}")
    runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

    if runtime_mode in ["full-access", "full_access"] do
      send_to_port(state, JsonRpc.encode_response(id, %{"decision" => "accept"}))

      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id,
        "decision" => "accept"
      })

      state
    else
      emit_event(state, :request, "request/opened", %{
        "requestId" => request_id,
        "requestType" => "dynamic_tool_call",
        "detail" => Map.get(params, "title") || Map.get(params, "toolName") || "permission",
        "args" => params
      })

      put_provider_pending(
        state,
        id,
        "session/request_permission",
        Map.put(params, "requestId", request_id)
      )
    end
  end

  defp handle_rpc_request(state, id, "session/elicitation", params) do
    request_id = Map.get(params, "requestId", "rpc-#{id}")

    emit_event(state, :request, "user-input/requested", %{
      "requestId" => request_id,
      "questions" => Map.get(params, "questions", []),
      "args" => params
    })

    put_provider_pending(
      state,
      id,
      "session/elicitation",
      Map.put(params, "requestId", request_id)
    )
  end

  defp handle_rpc_request(state, id, "fs/" <> _suffix, _params) do
    send_to_port(state, JsonRpc.encode_error_response(id, -32_601, "fs operations not supported"))
    state
  end

  defp handle_rpc_request(state, id, "terminal/" <> _suffix, _params) do
    send_to_port(
      state,
      JsonRpc.encode_error_response(id, -32_601, "terminal operations not supported")
    )

    state
  end

  defp handle_rpc_request(state, id, method, params) do
    emit_event(state, :notification, "acp/extension", %{
      "method" => method,
      "params" => params
    })

    send_to_port(
      state,
      JsonRpc.encode_error_response(id, -32_601, "Unhandled ACP request: #{method}")
    )

    state
  end

  defp handle_rpc_notification(state, "session/update", params) do
    case extract_session_update(params) do
      nil ->
        state

      update ->
        if should_apply_session_update?(state, update) do
          apply_session_update(state, update)
        else
          state
        end
    end
  end

  defp handle_rpc_notification(state, "session/elicitation/complete", params) do
    emit_event(state, :notification, "user-input/resolved", %{
      "requestId" => Map.get(params, "requestId"),
      "answers" => Map.get(params, "answers", %{})
    })

    state
  end

  defp handle_rpc_notification(state, method, params) do
    emit_event(state, :notification, "acp/extension", %{
      "method" => method,
      "params" => params
    })

    state
  end

  defp apply_session_update(state, %{"sessionUpdate" => "user_message_chunk"}), do: state

  defp apply_session_update(state, %{"sessionUpdate" => "agent_thought_chunk"} = update) do
    text = extract_content_text(update)

    if text == "" do
      state
    else
      state = ensure_reasoning_started(state)

      emit_event(state, :notification, "content/delta", %{
        "streamKind" => "reasoning_text",
        "delta" => text,
        "itemId" => state.reasoning_item_id,
        "turnId" => state.current_turn_id
      })

      state
    end
  end

  defp apply_session_update(state, %{"sessionUpdate" => "agent_message_chunk"} = update) do
    text = extract_content_text(update)

    if text == "" do
      state
    else
      state = maybe_complete_reasoning(state)

      emit_event(state, :notification, "content/delta", %{
        "streamKind" => "assistant_text",
        "delta" => text,
        "turnId" => state.current_turn_id
      })

      state
    end
  end

  defp apply_session_update(state, %{"sessionUpdate" => "tool_call"} = update) do
    item_id = Map.get(update, "toolCallId", generate_id())
    item_type = acp_kind_to_item_type(Map.get(update, "kind"))

    emit_event(state, :notification, "item/started", %{
      "itemId" => item_id,
      "itemType" => item_type,
      "toolName" => Map.get(update, "title", "Tool Call"),
      "detail" => Map.get(update, "rawInput"),
      "turnId" => state.current_turn_id
    })

    emit_tool_content(state, item_id, update, item_type)
    %{state | tool_items: MapSet.put(state.tool_items, item_id)}
  end

  defp apply_session_update(state, %{"sessionUpdate" => "tool_call_update"} = update) do
    item_id = Map.get(update, "toolCallId", generate_id())
    item_type = acp_kind_to_item_type(Map.get(update, "kind"))

    state =
      if MapSet.member?(state.tool_items, item_id) do
        state
      else
        emit_event(state, :notification, "item/started", %{
          "itemId" => item_id,
          "itemType" => item_type,
          "toolName" => Map.get(update, "title", "Tool Call"),
          "detail" => Map.get(update, "rawInput"),
          "turnId" => state.current_turn_id
        })

        %{state | tool_items: MapSet.put(state.tool_items, item_id)}
      end

    emit_tool_content(state, item_id, update, item_type)

    status = normalize_tool_status(Map.get(update, "status"))

    case status do
      "running" ->
        emit_event(state, :notification, "item/updated", %{
          "itemId" => item_id,
          "itemType" => item_type,
          "status" => "running",
          "turnId" => state.current_turn_id
        })

        state

      terminal ->
        emit_event(state, :notification, "item/completed", %{
          "itemId" => item_id,
          "itemType" => item_type,
          "toolName" => Map.get(update, "title", "Tool Call"),
          "status" => terminal,
          "turnId" => state.current_turn_id
        })

        %{state | tool_items: MapSet.delete(state.tool_items, item_id)}
    end
  end

  defp apply_session_update(state, %{"sessionUpdate" => "plan"} = update) do
    emit_event(state, :notification, "turn/plan/updated", %{
      "turnId" => state.current_turn_id,
      "entries" => Map.get(update, "entries", Map.get(update, "plan", []))
    })

    state
  end

  defp apply_session_update(state, %{"sessionUpdate" => "current_mode_update"} = update) do
    emit_event(state, :session, "session/configured", %{
      "currentModeId" => Map.get(update, "currentModeId")
    })

    state
  end

  defp apply_session_update(state, %{"sessionUpdate" => "available_commands_update"} = update) do
    emit_event(state, :notification, "acp/extension", %{
      "method" => "session/update",
      "params" => update
    })

    state
  end

  defp apply_session_update(state, update) do
    emit_event(state, :notification, "acp/session_update_unknown", %{
      "turnId" => state.current_turn_id,
      "update" => update
    })

    state
  end

  defp extract_session_update(%{"update" => %{"sessionUpdate" => session_update}} = params)
       when is_binary(session_update),
       do: Map.merge(params["update"], Map.delete(params, "update"))

  defp extract_session_update(%{"sessionUpdate" => session_update} = params)
       when is_binary(session_update),
       do: params

  defp extract_session_update(_params), do: nil

  defp emit_tool_content(state, item_id, update, item_type) do
    raw_output = get_in(update, ["rawOutput", "content"])

    content_text =
      case Map.get(update, "content", []) do
        content when is_list(content) ->
          content
          |> Enum.flat_map(fn
            %{"type" => "text", "text" => text} when is_binary(text) -> [text]
            _ -> []
          end)
          |> Enum.join("\n")

        %{"text" => text} when is_binary(text) ->
          text

        _ ->
          ""
      end

    output =
      cond do
        is_binary(raw_output) and raw_output != "" -> raw_output
        content_text != "" -> content_text
        true -> nil
      end

    if output do
      emit_event(state, :notification, "content/delta", %{
        "streamKind" => tool_stream_kind(item_type),
        "delta" => output,
        "itemId" => item_id,
        "turnId" => state.current_turn_id
      })
    end
  end

  defp tool_stream_kind("command_execution"), do: "command_output"
  defp tool_stream_kind("file_change"), do: "file_change_output"
  defp tool_stream_kind(_), do: "tool_output"

  defp ensure_reasoning_started(%{reasoning_item_id: nil} = state) do
    item_id = generate_id()

    emit_event(state, :notification, "item/started", %{
      "itemId" => item_id,
      "itemType" => "reasoning",
      "toolName" => "Thinking",
      "turnId" => state.current_turn_id
    })

    %{state | reasoning_item_id: item_id}
  end

  defp ensure_reasoning_started(state), do: state

  defp maybe_complete_reasoning(%{reasoning_item_id: nil} = state), do: state

  defp maybe_complete_reasoning(state) do
    emit_event(state, :notification, "item/completed", %{
      "itemId" => state.reasoning_item_id,
      "itemType" => "reasoning",
      "toolName" => "Thinking",
      "status" => "completed",
      "turnId" => state.current_turn_id
    })

    %{state | reasoning_item_id: nil}
  end

  defp complete_turn(state, status, extra \\ %{})

  defp complete_turn(%{current_turn_id: nil} = state, _status, _extra),
    do: %{state | status: :ready}

  defp complete_turn(state, status, extra) do
    state = maybe_complete_reasoning(state)
    stop_reason = Map.get(extra, "stopReason", status)

    emit_event(state, :notification, "turn/completed", %{
      "turn" => %{
        "id" => state.current_turn_id,
        "status" => status
      },
      "stopReason" => stop_reason,
      "usage" => Map.get(extra, "usage"),
      "providerTurnId" => Map.get(extra, "providerTurnId")
    })

    emit_event(state, :session, "session/state-changed", %{"state" => "ready"})

    turn =
      %{
        turn_id: state.current_turn_id,
        items: []
      }

    %{
      state
      | current_turn_id: nil,
        current_prompt_rpc_id: nil,
        status: :ready,
        tool_items: MapSet.new(),
        turns: state.turns ++ [turn]
    }
  end

  defp prompt_failure_status(%{"code" => code}) when code in [-32_800, -32_801], do: "interrupted"
  defp prompt_failure_status(_), do: "failed"

  defp spawn_cursor_acp(state) do
    cwd = Map.get(state.params, "cwd", File.cwd!())

    try do
      port =
        Port.open(
          {:spawn_executable, to_charlist(state.binary_path)},
          [
            :binary,
            :exit_status,
            :use_stdio,
            :stderr_to_stdout,
            {:line, 1_048_576},
            {:cd, to_charlist(cwd)},
            {:args, [~c"agent", ~c"acp"]},
            {:env, build_env()}
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp build_env do
    System.get_env()
    |> Enum.map(fn {k, v} -> {to_charlist(k), to_charlist(v)} end)
  end

  defp resolve_cursor_binary(opts) do
    params = Map.get(opts, :params, %{})
    provider_options = Map.get(params, "providerOptions", %{})
    cursor_options = Map.get(provider_options, "cursor", %{})

    Map.get(cursor_options, "binaryPath") ||
      System.find_executable("cursor") ||
      "cursor"
  end

  defp send_rpc_request(state, id, method, params, from \\ nil) do
    send_to_port(state, JsonRpc.encode_request(id, method, params))
    timer = if from, do: Process.send_after(self(), {:request_timeout, id}, @request_timeout)
    pending = Map.put(state.pending, id, %{method: method, from: from, timer: timer})
    %{state | pending: pending}
  end

  defp send_new_session_request(state) do
    {id, state} = next_request_id(state)

    send_rpc_request(state, id, "session/new", %{
      "cwd" => Map.get(state.params, "cwd", File.cwd!()),
      "mcpServers" => []
    })
  end

  defp bootstrap_session(state) do
    case extract_resume_session_id(state.params) do
      nil ->
        send_new_session_request(state)

      session_id ->
        {id, state} = next_request_id(state)

        send_rpc_request(state, id, "session/load", %{
          "sessionId" => session_id,
          "cwd" => Map.get(state.params, "cwd", File.cwd!()),
          "mcpServers" => []
        })
    end
  end

  defp extract_resume_session_id(params) do
    case get_in(params, ["resumeCursor"]) do
      nil ->
        nil

      json when is_binary(json) ->
        case Jason.decode(json) do
          {:ok, %{"sessionId" => session_id}} when is_binary(session_id) -> session_id
          _ -> nil
        end

      %{"sessionId" => session_id} when is_binary(session_id) ->
        session_id

      _ ->
        nil
    end
  end

  defp persist_binding(%{acp_session_id: session_id} = state) when is_binary(session_id) do
    Harness.Storage.upsert_binding(
      state.thread_id,
      state.provider,
      Jason.encode!(%{"schemaVersion" => 1, "sessionId" => session_id})
    )
  end

  defp persist_binding(_state), do: :ok

  defp maybe_cancel_ready_timer(%{ready_timer: nil} = state), do: state

  defp maybe_cancel_ready_timer(state) do
    Process.cancel_timer(state.ready_timer)
    %{state | ready_timer: nil}
  end

  defp wake_ready_waiters(state) do
    Enum.each(state.ready_waiters, &GenServer.reply(&1, :ok))
    %{state | ready_waiters: []}
  end

  defp stop_startup(state, message) do
    emit_event(state, :error, "runtime/error", %{
      "message" => message,
      "class" => "provider_startup_error",
      "provider" => "cursor"
    })

    Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, message}))
    state = %{state | ready_waiters: []}
    {:stop, {:startup_failed, message}, reject_all_pending(state, message)}
  end

  defp pick_auth_method(methods) when is_list(methods) do
    Enum.find_value(methods, fn
      %{"id" => "cursor_login"} -> "cursor_login"
      %{"id" => id} when is_binary(id) -> id
      _ -> nil
    end)
  end

  defp pick_auth_method(_), do: nil

  defp next_request_id(state), do: {state.next_id, %{state | next_id: state.next_id + 1}}

  defp ready?(state), do: state.status == :ready

  defp put_provider_pending(state, rpc_id, method, params) do
    pending =
      Map.put(state.pending, rpc_id, %{
        kind: :provider_request,
        method: method,
        params: params,
        from: nil,
        timer: nil
      })

    %{state | pending: pending}
  end

  defp find_pending_provider_request(state, request_id, method) do
    Enum.find(state.pending, fn
      {_id, %{kind: :provider_request, method: ^method, params: params}} ->
        Map.get(params, "requestId") == request_id

      _ ->
        false
    end)
  end

  defp remove_pending(state, id) do
    %{state | pending: Map.delete(state.pending, id)}
  end

  defp reject_all_pending(state, _reason) do
    Enum.each(state.pending, fn
      {_id, %{kind: :provider_request, method: "session/elicitation", params: params}} ->
        emit_event(state, :notification, "user-input/resolved", %{
          "requestId" => Map.get(params, "requestId", "unknown"),
          "answers" => %{}
        })

      {_id, %{kind: :provider_request, params: params}} ->
        emit_event(state, :notification, "request/resolved", %{
          "requestId" => Map.get(params, "requestId", "unknown"),
          "decision" => "cancel"
        })

      {_id, %{from: from, timer: timer}} ->
        if timer, do: Process.cancel_timer(timer)
        if from, do: GenServer.reply(from, {:error, "Session terminated"})

      _ ->
        :ok
    end)

    %{state | pending: %{}}
  end

  defp acp_kind_to_item_type("shell"), do: "command_execution"
  defp acp_kind_to_item_type("command"), do: "command_execution"
  defp acp_kind_to_item_type("file_edit"), do: "file_change"
  defp acp_kind_to_item_type("file_read"), do: "file_change"
  defp acp_kind_to_item_type("read"), do: "file_change"
  defp acp_kind_to_item_type("edit"), do: "file_change"
  defp acp_kind_to_item_type("write"), do: "file_change"
  defp acp_kind_to_item_type("mcp"), do: "mcp_tool_call"
  defp acp_kind_to_item_type(_), do: "dynamic_tool_call"

  defp normalize_tool_status(status) when status in ["completed", "success"], do: "completed"
  defp normalize_tool_status(status) when status in ["failed", "error"], do: "failed"
  defp normalize_tool_status(status) when status in ["cancelled", "canceled"], do: "interrupted"
  defp normalize_tool_status(_), do: "running"

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

  defp send_to_port(_, _message), do: :ok

  defp split_lines(buffer) do
    case String.split(buffer, "\n") do
      [single] ->
        {[], single}

      parts ->
        {lines, [remaining]} = Enum.split(parts, -1)
        {lines, remaining}
    end
  end

  defp reduce_lines(lines, state) do
    Enum.reduce_while(lines, {:continue, state}, fn line, {:continue, state} ->
      case process_line(line, state) do
        {:continue, state} -> {:cont, {:continue, state}}
        {:stop, reason, state} -> {:halt, {:stop, reason, state}}
      end
    end)
  end

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

  defp extract_content_text(%{"content" => %{"text" => text}}) when is_binary(text), do: text

  defp extract_content_text(%{"content" => [%{"text" => text} | _]}) when is_binary(text),
    do: text

  defp extract_content_text(_), do: ""

  defp prompt_stop_reason(%{"stopReason" => stop_reason}) when is_binary(stop_reason),
    do: stop_reason

  defp prompt_stop_reason(_), do: "end_turn"

  defp should_apply_session_update?(state, %{"sessionUpdate" => session_update}) do
    state.current_turn_id != nil or
      session_update in ["available_commands_update", "current_mode_update"]
  end

  defp extract_error(%{"code" => _code, "message" => _message} = error), do: error

  defp extract_error(other),
    do: %{"code" => -32_603, "message" => "Unknown failure: #{inspect(other)}"}

  defp generate_id do
    Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)
    |> then(fn hex ->
      <<a::binary-size(8), b::binary-size(4), c::binary-size(4), d::binary-size(4),
        e::binary-size(12)>> = hex

      "#{a}-#{b}-#{c}-#{d}-#{e}"
    end)
  end
end
