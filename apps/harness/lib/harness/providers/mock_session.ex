defmodule Harness.Providers.MockSession do
  @moduledoc """
  GenServer managing a mock Codex session for GC stress testing.

  Spawns `bun run scripts/mock-codex-server.ts` with configurable payload sizes.
  Speaks the same JSON-RPC 2.0 protocol as CodexSession but with controlled
  delta sizes for GC pressure testing.

  Provider options (via params["providerOptions"]["mock"]):
    - deltaCount: number of deltas per turn (default: 100)
    - deltaSizeKb: size of each delta in KB (default: 1)
    - delayMs: delay between deltas in ms (default: 10)
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

  @request_timeout 30_000

  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name: {:via, Registry, {Harness.SessionRegistry, thread_id, "mock"}}
    )
  end

  def send_turn(pid, params), do: GenServer.call(pid, {:send_turn, params}, 60_000)
  def interrupt_turn(pid, _tid, _turn_id), do: GenServer.call(pid, :interrupt_turn)
  def respond_to_approval(_, _, _), do: :ok
  def respond_to_user_input(_, _, _), do: :ok
  def read_thread(_, _), do: {:ok, %{}}
  def rollback_thread(_, _, _), do: {:ok, %{}}

  def wait_for_ready(pid, timeout \\ 30_000) do
    GenServer.call(pid, :wait_for_ready, timeout)
  end

  @impl true
  def init(opts) do
    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "mock",
      event_callback: Map.fetch!(opts, :event_callback),
      params: Map.get(opts, :params, %{}),
      buffer: ""
    }

    case spawn_mock(state) do
      {:ok, port} ->
        new_state = %{state | port: port}
        send(self(), :initialize)
        {:ok, new_state}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:initialize, state) do
    {id, state} = next_request_id(state)

    state =
      send_rpc_request(state, id, "initialize", %{
        "clientInfo" => %{"name" => "t3-harness-mock", "version" => "1.0.0"},
        "capabilities" => %{}
      })

    {:noreply, state}
  end

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

  @impl true
  def handle_info({port, {:data, data}}, %{port: port} = state) when is_binary(data) do
    buffer = state.buffer <> data
    {lines, remaining} = split_lines(buffer)
    state = %{state | buffer: remaining}
    state = Enum.reduce(lines, state, &process_line/2)
    {:noreply, state}
  end

  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    unless state.stopping do
      Logger.info("Mock process exited with status #{status} for thread #{state.thread_id}")
      emit_event(state, :session, "session/exited", %{"exitStatus" => status})
    end

    reject_all_pending(state, "Process exited")
    {:stop, :normal, state}
  end

  @impl true
  def handle_info({:request_timeout, id}, state) do
    case Map.pop(state.pending, id) do
      {nil, _} ->
        {:noreply, state}

      {%{from: from}, pending} ->
        if from, do: GenServer.reply(from, {:error, "Request timeout"})
        {:noreply, %{state | pending: pending}}
    end
  end

  @impl true
  def handle_info(:start_thread, state) do
    {id, state} = next_request_id(state)
    state = send_rpc_request(state, id, "thread/start", %{}, nil)
    pending_entry = Map.get(state.pending, id)
    state = put_in(state.pending[id], %{pending_entry | method: "thread/start"})
    emit_event(state, :session, "session/started", %{})
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

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
    codex_tid = state.codex_thread_id || state.thread_id
    {id, state} = next_request_id(state)

    raw_input = Map.get(params, "input", [])

    codex_input =
      cond do
        is_list(raw_input) -> raw_input
        is_binary(raw_input) -> [%{"type" => "text", "text" => raw_input}]
        true -> []
      end

    state =
      send_rpc_request(
        state,
        id,
        "turn/start",
        %{
          "threadId" => codex_tid,
          "input" => codex_input
        },
        from
      )

    {:noreply, state}
  end

  @impl true
  def handle_call(:interrupt_turn, from, state) do
    {id, state} = next_request_id(state)
    state = send_rpc_request(state, id, "turn/interrupt", %{}, from)
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

    Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, "Session terminated"}))
    reject_all_pending(state, "Session terminated")
    :ok
  end

  # --- Private ---

  defp spawn_mock(state) do
    mock_opts = get_in(state.params, ["providerOptions", "mock"]) || %{}
    delta_count = Map.get(mock_opts, "deltaCount", 100) |> to_string()
    delta_size_kb = Map.get(mock_opts, "deltaSizeKb", 1) |> to_string()
    delay_ms = Map.get(mock_opts, "delayMs", 10) |> to_string()
    mode = Map.get(mock_opts, "mode", "normal") |> to_string()

    bun_path = System.find_executable("bun") || "bun"
    # Resolve the project root from this source file's compile-time path.
    # This works in both dev and release builds.
    project_root = Path.join([__DIR__, "..", "..", "..", "..", ".."]) |> Path.expand()
    script_path = Path.join([project_root, "scripts", "mock-codex-server.ts"])

    try do
      port =
        Port.open(
          {:spawn_executable, to_charlist(bun_path)},
          [
            :binary,
            :exit_status,
            :use_stdio,
            args: [
              ~c"run",
              to_charlist(script_path),
              to_charlist(delta_count),
              to_charlist(delta_size_kb),
              to_charlist(delay_ms),
              to_charlist(mode)
            ],
            # 1MB line buffer for large payloads
            line: 1_048_576
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

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

        {:notification, method, params} ->
          handle_rpc_notification(state, method, params)

        {:request, id, method, params} ->
          handle_rpc_request(state, id, method, params)

        {:error, _} ->
          Logger.warning("MockSession: failed to parse line: #{String.slice(line, 0, 200)}")
          state
      end
    end
  end

  defp handle_rpc_response(state, id, result) do
    case Map.pop(state.pending, id) do
      {nil, _} ->
        state

      {%{from: nil, method: "initialize"}, pending} ->
        state = %{state | pending: pending}
        send_to_port(state, JsonRpc.encode_notification("initialized"))
        # Don't emit session/ready here — wait for thread/start
        send(self(), :start_thread)
        state

      {%{from: nil, method: "thread/start"}, pending} ->
        codex_id = get_in(result, ["thread", "id"])
        state = %{state | pending: pending, codex_thread_id: codex_id, ready: true}
        emit_event(state, :session, "session/ready", %{})
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
      {nil, _} ->
        state

      {%{from: from, timer: timer, method: method}, pending} ->
        if timer, do: Process.cancel_timer(timer)
        message = Map.get(error, "message", "Unknown error")
        if from, do: GenServer.reply(from, {:error, message})
        state = %{state | pending: pending}
        # If startup failed, wake up ready_waiters with error
        if method in ["initialize", "thread/start"] do
          Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, message}))
          %{state | ready_waiters: []}
        else
          state
        end
    end
  end

  defp handle_rpc_request(state, id, method, params) do
    emit_event(state, :request, method, Map.put(params, "rpcId", id))

    %{
      state
      | pending:
          Map.put(state.pending, id, %{
            kind: :provider_request,
            method: method,
            params: params,
            from: nil,
            timer: nil
          })
    }
  end

  defp handle_rpc_notification(state, method, params) do
    emit_event(state, :notification, method, params)
    state
  end

  defp next_request_id(%{next_id: id} = state), do: {id, %{state | next_id: id + 1}}

  defp send_rpc_request(state, id, method, params, from \\ nil) do
    message = JsonRpc.encode_request(id, method, params)
    send_to_port(state, message)
    timer = if from, do: Process.send_after(self(), {:request_timeout, id}, @request_timeout)
    %{state | pending: Map.put(state.pending, id, %{method: method, from: from, timer: timer})}
  end

  defp send_to_port(%{port: port}, message), do: Port.command(port, message <> "\n")

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
end
