defmodule Harness.Providers.CodexSession do
  @moduledoc """
  GenServer managing a single Codex app-server process.

  Replaces CodexAppServerManager from the Node codebase.
  Spawns `codex app-server` via Erlang Port, speaks JSON-RPC 2.0 over stdio.
  """
  use GenServer, restart: :temporary

  alias Harness.JsonRpc
  alias Harness.Event

  require Logger

  defstruct [
    :thread_id,
    :provider,
    :port,
    :event_callback,
    :params,
    :buffer,
    :codex_thread_id,
    next_id: 1,
    pending: %{},
    stopping: false,
    ready: false,
    ready_waiters: []
  ]

  @request_timeout 20_000

  # --- Public API ---

  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, Map.get(opts, :provider, "codex")}}
    )
  end

  def send_turn(pid, params) do
    GenServer.call(pid, {:send_turn, params}, 30_000)
  end

  def interrupt_turn(pid, _thread_id, turn_id) do
    GenServer.call(pid, {:interrupt_turn, turn_id})
  end

  def respond_to_approval(pid, request_id, decision) do
    GenServer.call(pid, {:respond_to_approval, request_id, decision})
  end

  def respond_to_user_input(pid, request_id, answers) do
    GenServer.call(pid, {:respond_to_user_input, request_id, answers})
  end

  def read_thread(pid, thread_id) do
    GenServer.call(pid, {:read_thread, thread_id}, 30_000)
  end

  def rollback_thread(pid, thread_id, num_turns) do
    GenServer.call(pid, {:rollback_thread, thread_id, num_turns}, 30_000)
  end

  def wait_for_ready(pid, timeout \\ 30_000) do
    GenServer.call(pid, :wait_for_ready, timeout)
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: Map.get(opts, :provider, "codex"),
      event_callback: Map.fetch!(opts, :event_callback),
      params: Map.get(opts, :params, %{}),
      buffer: ""
    }

    case spawn_codex(state) do
      {:ok, port} ->
        new_state = %{state | port: port}
        # Start initialization handshake
        send(self(), :initialize)
        {:ok, new_state}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:initialize, state) do
    # Send JSON-RPC initialize request
    {id, state} = next_request_id(state)

    # Check if experimentalApi is requested via providerOptions
    codex_opts = get_in(state.params, ["providerOptions", "codex"]) || %{}
    experimental_api = Map.get(codex_opts, "experimentalApi", false)

    capabilities = if experimental_api do
      %{"experimentalApi" => true}
    else
      %{}
    end

    initialize_params = %{
      "clientInfo" => %{
        "name" => "t3-harness",
        "version" => "0.1.0"
      },
      "capabilities" => capabilities
    }

    state = send_rpc_request(state, id, "initialize", initialize_params)
    {:noreply, state}
  end

  # Port data received (stdout from codex process)
  # {:spawn_executable, ...} with {:line, N} sends {:eol, line} / {:noeol, chunk}
  @impl true
  def handle_info({port, {:data, {:eol, line}}}, %{port: port} = state) do
    full_line = state.buffer <> to_string(line)
    state = %{state | buffer: ""}
    state = process_line(full_line, state)
    {:noreply, state}
  end

  @impl true
  def handle_info({port, {:data, {:noeol, chunk}}}, %{port: port} = state) do
    {:noreply, %{state | buffer: state.buffer <> to_string(chunk)}}
  end

  # Fallback for raw binary data (from {:spawn, ...})
  @impl true
  def handle_info({port, {:data, data}}, %{port: port} = state) when is_binary(data) do
    buffer = state.buffer <> data
    {lines, remaining} = split_lines(buffer)
    state = %{state | buffer: remaining}
    state = Enum.reduce(lines, state, &process_line/2)
    {:noreply, state}
  end

  # Port exit
  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    unless state.stopping do
      Logger.info("Codex process exited with status #{status} for thread #{state.thread_id}")

      emit_event(state, :session, "session/exited", %{
        "exitStatus" => status,
        "exitKind" => if(status == 0, do: "graceful", else: "error")
      })
    end

    # Reject all pending requests
    state = reject_all_pending(state, "Process exited")

    {:stop, :normal, state}
  end

  # Request timeout
  @impl true
  def handle_info({:request_timeout, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        {:noreply, state}

      {%{from: from}, pending} ->
        GenServer.reply(from, {:error, "Request timeout"})
        {:noreply, %{state | pending: pending}}
    end
  end

  # Thread start (after initialize handshake)
  @impl true
  def handle_info(:start_thread, state) do
    {id, state} = next_request_id(state)
    resume_cursor = get_in(state.params, ["resumeCursor"])

    {method, params} =
      if resume_cursor do
        {"thread/resume", %{
          "threadId" => resume_cursor,
          "overrides" => thread_overrides(state)
        }}
      else
        {"thread/start", thread_overrides(state)}
      end

    state = send_rpc_request(state, id, method, params, nil)

    # Override pending to handle thread start response specially
    pending_entry = Map.get(state.pending, id)
    state = put_in(state.pending[id], %{pending_entry | method: "thread/start"})

    emit_event(state, :session, "session/started", %{})
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # --- Command Handlers ---

  @impl true
  def handle_call(:wait_for_ready, _from, %{ready: true} = state) do
    {:reply, :ok, state}
  end

  @impl true
  def handle_call(:wait_for_ready, from, state) do
    {:noreply, %{state | ready_waiters: [from | state.ready_waiters]}}
  end

  @impl true
  def handle_call({:send_turn, params}, from, state) do
    # Use the Codex-internal thread ID (UUID), not our harness thread ID
    codex_tid = state.codex_thread_id || state.thread_id
    {id, state} = next_request_id(state)

    # Codex turn/start expects input as an array of items with type "text".
    # ProviderSendTurnInput.input is a plain string from the orchestration layer.
    raw_input = Map.get(params, "input", [])
    codex_input = cond do
      is_list(raw_input) -> raw_input
      is_binary(raw_input) -> [%{"type" => "text", "text" => raw_input}]
      true -> []
    end

    turn_params = %{
      "threadId" => codex_tid,
      "input" => codex_input,
      "model" => Map.get(params, "model"),
      "effort" => Map.get(params, "effort"),
      "collaborationMode" => Map.get(params, "collaborationMode")
    }
    |> reject_nil_values()

    state = send_rpc_request(state, id, "turn/start", turn_params, from)
    {:noreply, state}
  end

  @impl true
  def handle_call({:interrupt_turn, turn_id}, from, state) do
    codex_tid = state.codex_thread_id || state.thread_id
    {id, state} = next_request_id(state)

    params = %{"threadId" => codex_tid}
    params = if turn_id, do: Map.put(params, "turnId", turn_id), else: params

    state = send_rpc_request(state, id, "turn/interrupt", params, from)
    {:noreply, state}
  end

  @impl true
  def handle_call({:respond_to_approval, request_id, decision}, _from, state) do
    # Find the pending approval by request_id
    case find_pending_approval(state, request_id) do
      {rpc_id, _request} ->
        response = JsonRpc.encode_response(rpc_id, %{"decision" => decision})
        send_to_port(state, response)
        {:reply, :ok, remove_pending(state, rpc_id)}

      nil ->
        {:reply, {:error, "Approval request not found: #{request_id}"}, state}
    end
  end

  @impl true
  def handle_call({:respond_to_user_input, request_id, answers}, _from, state) do
    case find_pending_approval(state, request_id) do
      {rpc_id, _request} ->
        response = JsonRpc.encode_response(rpc_id, %{"answers" => answers})
        send_to_port(state, response)
        {:reply, :ok, remove_pending(state, rpc_id)}

      nil ->
        {:reply, {:error, "User input request not found: #{request_id}"}, state}
    end
  end

  @impl true
  def handle_call({:read_thread, thread_id}, from, state) do
    {id, state} = next_request_id(state)
    state = send_rpc_request(state, id, "thread/read", %{"threadId" => thread_id, "includeTurns" => true}, from)
    {:noreply, state}
  end

  @impl true
  def handle_call({:rollback_thread, thread_id, num_turns}, from, state) do
    {id, state} = next_request_id(state)
    state = send_rpc_request(state, id, "thread/rollback", %{"threadId" => thread_id, "numTurns" => num_turns}, from)
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopping: true}

    if state.port do
      try do
        Port.close(state.port)
      catch
        _, _ -> :ok
      end
    end

    # Reject ready waiters
    Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, "Session terminated"}))

    reject_all_pending(state, "Session terminated")
    :ok
  end

  # --- Port/Process Management ---

  defp spawn_codex(_state) do
    codex_path = System.find_executable("codex")

    if codex_path do
      port =
        Port.open(
          {:spawn_executable, codex_path},
          [
            :binary,
            :exit_status,
            :use_stdio,
            :stderr_to_stdout,
            args: ["app-server"],
            line: 65_536
          ]
        )

      {:ok, port}
    else
      {:error, :codex_not_found}
    end
  end

  # --- JSON-RPC Processing ---

  defp process_line(line, state) do
    line = String.trim(line)

    if line == "" do
      state
    else
      case JsonRpc.decode(line) do
        {:response, id, result} ->
          handle_rpc_response(state, id, result)

        {:error_response, id, error} ->
          handle_rpc_error(state, id, error)

        {:request, id, method, params} ->
          handle_rpc_request(state, id, method, params)

        {:notification, method, params} ->
          handle_rpc_notification(state, method, params)

        {:error, _reason} ->
          Logger.warning("Failed to parse JSON-RPC line: #{String.slice(line, 0, 200)}")
          state
      end
    end
  end

  defp handle_rpc_response(state, id, result) do
    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        state

      {%{from: nil, method: "initialize"}, pending} ->
        # Initialize response — send initialized notification, then start thread
        state = %{state | pending: pending}
        send_to_port(state, JsonRpc.encode_notification("initialized"))

        emit_event(state, :session, "session/ready", %{})

        # Start or resume thread
        send(self(), :start_thread)
        state

      {%{from: nil, method: "thread/start"}, pending} ->
        # Thread started — capture the Codex-internal thread ID
        codex_id = get_in(result, ["thread", "id"])
        state = %{state | pending: pending, codex_thread_id: codex_id, ready: true}
        # Note: session/started already emitted in :start_thread handler — don't duplicate.
        # Notify any callers waiting for ready
        Enum.each(state.ready_waiters, &GenServer.reply(&1, :ok))
        %{state | ready_waiters: []}

      {%{from: from, timer: timer}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        if from, do: GenServer.reply(from, {:ok, result})
        %{state | pending: pending}
    end
  end

  defp handle_rpc_error(state, id, error) do
    case Map.pop(state.pending, id) do
      {nil, _pending} ->
        state

      {%{from: from, timer: timer}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        message = Map.get(error, "message", "Unknown error")
        if from, do: GenServer.reply(from, {:error, message})
        %{state | pending: pending}
    end
  end

  defp handle_rpc_request(state, id, method, params) do
    # Classify the request: user-input vs approval
    request_id = Map.get(params, "requestId", "rpc-#{id}")
    is_user_input = method in ["ask_user", "user_input", "elicitation"] or
      String.contains?(String.downcase(method), "ask_user")

    if is_user_input do
      # User input flow — emit as user-input/requested
      questions = Map.get(params, "questions", [Map.get(params, "question", %{})])
      emit_event(state, :request, "user-input/requested", %{
        "requestId" => request_id,
        "rpcId" => id,
        "questions" => questions
      })
    else
      # Standard approval flow
      emit_event(state, :request, method, Map.put(params, "rpcId", id))
    end

    # Store as pending so we can respond later
    pending = Map.put(state.pending, id, %{
      kind: :provider_request,
      method: method,
      params: Map.put(params, "requestId", request_id),
      from: nil,
      timer: nil
    })

    %{state | pending: pending}
  end

  defp handle_rpc_notification(state, method, params) do
    # Intercept Codex collaboration events and emit structured harness events
    msg = get_in(params, ["msg"]) || %{}
    msg_type = Map.get(msg, "type", "")

    cond do
      String.contains?(msg_type, "collab_agent_spawn_begin") ->
        emit_event(state, :notification, "collab_agent_spawn_begin", %{
          "agentId" => Map.get(msg, "agent_id"),
          "agentName" => Map.get(msg, "agent_name"),
          "task" => Map.get(msg, "task"),
          "turnId" => Map.get(msg, "turn_id")
        })

      String.contains?(msg_type, "collab_agent_spawn_end") ->
        emit_event(state, :notification, "collab_agent_spawn_end", %{
          "agentId" => Map.get(msg, "agent_id"),
          "agentName" => Map.get(msg, "agent_name"),
          "status" => Map.get(msg, "status"),
          "turnId" => Map.get(msg, "turn_id")
        })

      String.contains?(msg_type, "collab_agent_interaction_begin") ->
        emit_event(state, :notification, "collab_agent_interaction_begin", %{
          "agentId" => Map.get(msg, "agent_id"),
          "turnId" => Map.get(msg, "turn_id")
        })

      String.contains?(msg_type, "collab_agent_interaction_end") ->
        emit_event(state, :notification, "collab_agent_interaction_end", %{
          "agentId" => Map.get(msg, "agent_id"),
          "turnId" => Map.get(msg, "turn_id")
        })

      String.contains?(msg_type, "collab_waiting") ->
        emit_event(state, :notification, msg_type, %{
          "turnId" => Map.get(msg, "turn_id")
        })

      true ->
        :ok
    end

    # Always emit the raw event for full observability
    emit_event(state, :notification, method, params)
    state
  end

  # --- Thread Helpers ---

  defp thread_overrides(state) do
    runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

    {approval_policy, sandbox} = case runtime_mode do
      "approval-required" -> {"on-request", "workspace-write"}
      _ -> {"never", "danger-full-access"}
    end

    %{
      "model" => Map.get(state.params, "model"),
      "cwd" => Map.get(state.params, "cwd"),
      "approvalPolicy" => approval_policy,
      "sandbox" => sandbox
    }
    |> reject_nil_values()
  end

  # --- Helpers ---

  defp next_request_id(%{next_id: id} = state) do
    {id, %{state | next_id: id + 1}}
  end

  defp send_rpc_request(state, id, method, params, from \\ nil) do
    message = JsonRpc.encode_request(id, method, params)
    send_to_port(state, message)

    timer =
      if from do
        Process.send_after(self(), {:request_timeout, id}, @request_timeout)
      end

    pending = Map.put(state.pending, id, %{
      method: method,
      from: from,
      timer: timer
    })

    %{state | pending: pending}
  end

  defp send_to_port(%{port: port}, message) do
    Port.command(port, message <> "\n")
  end

  defp emit_event(state, kind, method, payload) do
    event = Event.new(%{
      thread_id: state.thread_id,
      provider: state.provider,
      kind: kind,
      method: method,
      payload: payload
    })

    state.event_callback.(event)
  end

  defp find_pending_approval(state, request_id) do
    Enum.find(state.pending, fn
      {_id, %{kind: :provider_request, params: params}} ->
        Map.get(params, "requestId") == request_id

      _ ->
        false
    end)
  end

  defp remove_pending(state, id) do
    %{state | pending: Map.delete(state.pending, id)}
  end

  defp reject_all_pending(state, reason) do
    Enum.each(state.pending, fn
      {_id, %{from: from, timer: timer}} when not is_nil(from) ->
        if timer, do: Process.cancel_timer(timer)
        GenServer.reply(from, {:error, reason})

      _ ->
        :ok
    end)

    %{state | pending: %{}}
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

  defp reject_nil_values(map) do
    Map.reject(map, fn {_k, v} -> is_nil(v) end)
  end
end
