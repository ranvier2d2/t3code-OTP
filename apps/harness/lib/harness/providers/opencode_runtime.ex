defmodule Harness.Providers.OpenCodeRuntime do
  @moduledoc """
  GenServer managing a shared OpenCode runtime process (`opencode serve`).

  Owns the OS process, port, base URL, SSE listener, and runtime health.
  Multiple `OpenCodeSession` thread wrappers can lease this runtime when
  their runtime key matches.

  ## Responsibilities

  - Spawn and manage `opencode serve` OS process
  - Maintain SSE connection to `/event` for real-time events
  - Fan out SSE events to subscribed thread wrappers (filtered by session ID)
  - Provide HTTP API proxying (session CRUD, MCP, models, prompts, etc.)
  - Track subscribers and manage idle TTL shutdown

  ## Event Fanout Model

  The runtime reads SSE once at the runtime level. It republishes raw OpenCode
  events to all subscribed thread wrappers. Each thread wrapper filters by its
  own `opencode_session_id` before emitting harness events.
  """
  use GenServer, restart: :temporary

  require Logger

  alias Harness.OpenCode.RuntimeKey
  alias Harness.OpenCode.RuntimeRegistry

  @sse_initial_delay 1_000
  @sse_max_delay 60_000
  @sse_max_retries 30
  @sse_backoff_multiplier 1.5
  @idle_ttl_ms 5 * 60 * 1_000
  @health_check_interval_ms 30_000

  defstruct [
    :runtime_key,
    :port,
    :opencode_port,
    :sse_pid,
    :base_url,
    :binary_path,
    :params,
    subscribers: %{},
    sse_buffer: "",
    stopped: false,
    ready: false,
    ready_waiters: [],
    health: :booting,
    idle_timer_ref: nil,
    sse_reconnect_attempts: 0
  ]

  # --- Public API ---

  @doc """
  Start a runtime process under the runtime DynamicSupervisor.
  """
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @doc """
  Atomically find-or-create a shared runtime AND subscribe the caller
  for SSE events. Combines lease + subscribe into one operation so
  there is no window where the ref count is incremented but the caller
  is not yet monitored.

  Returns `{:ok, runtime_pid}` or `{:error, reason}`.
  """
  @max_lease_retries 3

  @spec lease_and_subscribe(RuntimeKey.t(), map(), String.t(), pid()) ::
          {:ok, pid()} | {:error, term()}
  def lease_and_subscribe(%RuntimeKey{} = key, params, thread_id, wrapper_pid) do
    do_lease_and_subscribe(key, params, thread_id, wrapper_pid, @max_lease_retries)
  end

  defp do_lease_and_subscribe(_key, _params, _thread_id, _wrapper_pid, 0) do
    {:error, {:lease_failed, :retries_exhausted}}
  end

  defp do_lease_and_subscribe(key, params, thread_id, wrapper_pid, attempts_left) do
    case RuntimeRegistry.lookup(key) do
      {:ok, pid} ->
        case GenServer.call(pid, {:lease_and_subscribe, key, thread_id, wrapper_pid}) do
          :ok ->
            {:ok, pid}

          {:error, :not_found} ->
            do_lease_and_subscribe(key, params, thread_id, wrapper_pid, attempts_left - 1)
        end

      :error ->
        case start_new_runtime_subscribed(key, params, thread_id, wrapper_pid) do
          {:ok, pid} ->
            {:ok, pid}

          {:error, {:registration_race, _}} ->
            do_lease_and_subscribe(key, params, thread_id, wrapper_pid, attempts_left - 1)

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  @doc """
  Release a thread's lease on a runtime. Sends an unsubscribe cast
  which handles both subscriber removal and ref count decrement.
  """
  @spec release(RuntimeKey.t(), String.t()) :: :ok
  def release(%RuntimeKey{} = key, thread_id) do
    case RuntimeRegistry.lookup(key) do
      {:ok, pid} -> GenServer.cast(pid, {:unsubscribe, thread_id})
      :error -> :ok
    end

    :ok
  end

  @doc """
  Wait until the runtime is ready (opencode serve is up + SSE connected).
  """
  @spec wait_for_ready(pid(), timeout()) :: :ok | {:error, term()}
  def wait_for_ready(runtime_pid, timeout \\ 45_000) do
    GenServer.call(runtime_pid, :wait_for_ready, timeout)
  end

  @doc "Get the base URL of the runtime's OpenCode server."
  @spec get_base_url(pid()) :: String.t()
  def get_base_url(runtime_pid) do
    GenServer.call(runtime_pid, :get_base_url)
  end

  @doc "Get the runtime key."
  @spec get_runtime_key(pid()) :: RuntimeKey.t()
  def get_runtime_key(runtime_pid) do
    GenServer.call(runtime_pid, :get_runtime_key)
  end

  # --- HTTP proxy calls (forwarded by thread wrappers) ---

  @doc "Create a new OpenCode session on this runtime."
  @spec create_session(pid(), String.t()) :: {:ok, String.t()} | {:error, term()}
  def create_session(runtime_pid, thread_id) do
    GenServer.call(runtime_pid, {:create_session, thread_id}, 30_000)
  end

  @doc "Verify that an OpenCode session still exists."
  @spec verify_session(pid(), String.t()) :: :ok | {:error, term()}
  def verify_session(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:verify_session, session_id}, 15_000)
  end

  @doc "Delete an OpenCode session from the server."
  @spec delete_session(pid(), String.t()) :: :ok | {:error, term()}
  def delete_session(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:delete_session, session_id}, 15_000)
  end

  @doc "Send a prompt to a session (non-blocking on the OpenCode side)."
  @spec send_prompt(pid(), String.t(), map()) :: :ok | {:error, term()}
  def send_prompt(runtime_pid, session_id, body) do
    GenServer.call(runtime_pid, {:send_prompt, session_id, body}, 30_000)
  end

  @doc "Abort an active session."
  @spec abort_session(pid(), String.t()) :: :ok | {:error, term()}
  def abort_session(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:abort_session, session_id}, 15_000)
  end

  @doc "Revert session to previous state."
  @spec revert_session(pid(), String.t()) :: :ok | {:error, term()}
  def revert_session(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:revert_session, session_id}, 15_000)
  end

  @doc "Reply to a permission request."
  @spec reply_to_permission(pid(), String.t(), String.t(), String.t()) :: :ok | {:error, term()}
  def reply_to_permission(runtime_pid, session_id, permission_id, reply) do
    GenServer.call(runtime_pid, {:reply_to_permission, session_id, permission_id, reply}, 15_000)
  end

  @doc "Fetch messages for a session."
  @spec fetch_messages(pid(), String.t()) :: {:ok, list()} | {:error, term()}
  def fetch_messages(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:fetch_messages, session_id}, 15_000)
  end

  @doc "Get session details."
  @spec get_session(pid(), String.t()) :: {:ok, map()} | {:error, term()}
  def get_session(runtime_pid, session_id) do
    GenServer.call(runtime_pid, {:get_session, session_id}, 15_000)
  end

  # --- MCP operations ---

  @doc "Get MCP server status."
  @spec mcp_status(pid()) :: {:ok, map()} | {:error, term()}
  def mcp_status(runtime_pid) do
    GenServer.call(runtime_pid, :mcp_status, 15_000)
  end

  @doc "Add an MCP server configuration."
  @spec mcp_add(pid(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def mcp_add(runtime_pid, name, config) do
    GenServer.call(runtime_pid, {:mcp_add, name, config}, 15_000)
  end

  @doc "Connect an MCP server."
  @spec mcp_connect(pid(), String.t()) :: :ok | {:error, term()}
  def mcp_connect(runtime_pid, name) do
    GenServer.call(runtime_pid, {:mcp_connect, name}, 15_000)
  end

  @doc "Disconnect an MCP server."
  @spec mcp_disconnect(pid(), String.t()) :: :ok | {:error, term()}
  def mcp_disconnect(runtime_pid, name) do
    GenServer.call(runtime_pid, {:mcp_disconnect, name}, 15_000)
  end

  @doc "List providers/models from the runtime."
  @spec fetch_providers(pid()) :: {:ok, list()} | {:error, term()}
  def fetch_providers(runtime_pid) do
    GenServer.call(runtime_pid, :fetch_providers, 15_000)
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(opts) do
    params = Map.get(opts, :params, %{})
    runtime_key = Map.fetch!(opts, :runtime_key)

    state = %__MODULE__{
      runtime_key: runtime_key,
      params: params,
      binary_path: resolve_opencode_binary(params),
      opencode_port: find_available_port()
    }

    state = %{state | base_url: "http://127.0.0.1:#{state.opencode_port}"}

    case spawn_opencode(state) do
      {:ok, port} ->
        state = %{state | port: port}
        send(self(), :setup)
        {:ok, state}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:setup, state) do
    case wait_for_server(state.base_url, 45) do
      :ok ->
        sse_pid = start_sse_listener(state)
        state = %{state | sse_pid: sse_pid, ready: true, health: :ready}

        Logger.info(
          "OpenCode runtime ready on port #{state.opencode_port} " <>
            "(key: #{RuntimeKey.to_string(state.runtime_key)})"
        )

        Enum.each(state.ready_waiters, &GenServer.reply(&1, :ok))
        state = %{state | ready_waiters: []}
        {:noreply, state}

      {:error, :timeout} ->
        Logger.error("OpenCode runtime failed to start on port #{state.opencode_port}")
        {:stop, :server_timeout, state}
    end
  end

  # Port exit (opencode process died)
  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    unless state.stopped do
      Logger.warning(
        "OpenCode runtime process exited with status #{status} " <>
          "(key: #{RuntimeKey.to_string(state.runtime_key)})"
      )

      # Notify all subscribers that the runtime died
      Enum.each(state.subscribers, fn {_thread_id, wrapper_pid} ->
        send(wrapper_pid, {:runtime_down, self(), status})
      end)
    end

    RuntimeRegistry.unregister(state.runtime_key)
    {:stop, :normal, state}
  end

  # SSE chunks from the Req streaming listener
  @impl true
  def handle_info({:sse_chunk, chunk}, state) do
    buffer = (state.sse_buffer || "") <> chunk
    {events, remaining} = parse_sse_events(buffer)
    state = %{state | sse_buffer: remaining, sse_reconnect_attempts: 0}

    Enum.each(events, fn event ->
      fanout_event(state, event)
    end)

    {:noreply, state}
  end

  # Legacy SSE event format
  @impl true
  def handle_info({:sse_event, event}, state) do
    fanout_event(state, event)
    {:noreply, %{state | sse_reconnect_attempts: 0}}
  end

  # SSE listener died
  @impl true
  def handle_info({:sse_down, reason}, state) do
    schedule_sse_reconnect(state, reason)
  end

  # SSE process monitor DOWN
  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, %{sse_pid: pid} = state) do
    schedule_sse_reconnect(state, reason)
  end

  # Subscriber wrapper process died
  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    # Find and remove the dead subscriber
    case Enum.find(state.subscribers, fn {_tid, wpid} -> wpid == pid end) do
      {thread_id, _} ->
        Logger.info("Thread wrapper #{thread_id} died, removing subscription from runtime")
        subscribers = Map.delete(state.subscribers, thread_id)
        state = %{state | subscribers: subscribers}

        # Decrement ref count
        RuntimeRegistry.decrement_ref(state.runtime_key)
        maybe_schedule_idle_shutdown(state)

      nil ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:reconnect_sse, %{stopped: false} = state) do
    sse_pid = start_sse_listener(state)
    {:noreply, %{state | sse_pid: sse_pid}}
  end

  @impl true
  def handle_info(:idle_shutdown, state) do
    ref_count = RuntimeRegistry.ref_count(state.runtime_key)

    if ref_count == 0 and map_size(state.subscribers) == 0 do
      Logger.info(
        "Runtime idle TTL expired, shutting down " <>
          "(key: #{RuntimeKey.to_string(state.runtime_key)})"
      )

      RuntimeRegistry.unregister(state.runtime_key)
      {:stop, :normal, %{state | stopped: true}}
    else
      # A new lease arrived while we were waiting — cancel shutdown
      {:noreply, %{state | idle_timer_ref: nil}}
    end
  end

  @impl true
  def handle_info(:health_check, state) do
    case http_get("#{state.base_url}/global/health") do
      {:ok, %{"healthy" => true}} ->
        Process.send_after(self(), :health_check, @health_check_interval_ms)
        {:noreply, %{state | health: :ready}}

      _ ->
        Logger.warning("Runtime health check failed (key: #{RuntimeKey.to_string(state.runtime_key)})")
        Process.send_after(self(), :health_check, @health_check_interval_ms)
        {:noreply, %{state | health: :degraded}}
    end
  end

  @impl true
  def handle_info({_port, {:data, _data}}, state) do
    # Ignore stdout/stderr from opencode process
    {:noreply, state}
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

  # --- Metadata ---

  @impl true
  def handle_call(:get_base_url, _from, state) do
    {:reply, state.base_url, state}
  end

  @impl true
  def handle_call(:get_runtime_key, _from, state) do
    {:reply, state.runtime_key, state}
  end

  # --- Subscriber management ---

  # Atomic lease + subscribe: increment ref count, monitor, and add to
  # subscribers in a single GenServer.call — no gap for the caller to die
  # without cleanup.
  @impl true
  def handle_call({:lease_and_subscribe, key, thread_id, wrapper_pid}, _from, state) do
    if Map.has_key?(state.subscribers, thread_id) do
      # Already subscribed — skip to avoid double monitor / ref count leak
      {:reply, :ok, state}
    else
      case RuntimeRegistry.increment_ref(key) do
        {:ok, _count} ->
          Process.monitor(wrapper_pid)
          subscribers = Map.put(state.subscribers, thread_id, wrapper_pid)
          state = %{state | subscribers: subscribers}
          state = cancel_idle_timer(state)
          {:reply, :ok, state}

        {:error, :not_found} ->
          {:reply, {:error, :not_found}, state}
      end
    end
  end

  # Subscribe without incrementing — used after start_new_runtime where
  # register/2 already set ref_count to 1.
  @impl true
  def handle_call({:subscribe_initial, thread_id, wrapper_pid}, _from, state) do
    if Map.has_key?(state.subscribers, thread_id) do
      {:reply, :ok, state}
    else
      Process.monitor(wrapper_pid)
      subscribers = Map.put(state.subscribers, thread_id, wrapper_pid)
      state = %{state | subscribers: subscribers}
      state = cancel_idle_timer(state)
      {:reply, :ok, state}
    end
  end

  # --- Session CRUD ---

  @impl true
  def handle_call({:create_session, thread_id}, _from, state) do
    case http_post("#{state.base_url}/session", %{"title" => "harness-#{thread_id}"}) do
      {:ok, %{"id" => id}} -> {:reply, {:ok, id}, state}
      {:ok, session} -> {:reply, {:ok, Map.get(session, "id")}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:verify_session, session_id}, _from, state) do
    case http_get("#{state.base_url}/session/#{session_id}") do
      {:ok, %{"id" => ^session_id}} -> {:reply, :ok, state}
      {:ok, body} -> {:reply, {:error, {:unexpected_session_payload, body}}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:delete_session, session_id}, _from, state) do
    case http_delete("#{state.base_url}/session/#{session_id}") do
      {:ok, _} ->
        Logger.info("Deleted OpenCode session #{session_id} from runtime")
        {:reply, :ok, state}

      {:error, reason} ->
        Logger.warning("Failed to delete OpenCode session #{session_id}: #{inspect(reason)}")
        {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:send_prompt, session_id, body}, _from, state) do
    url = "#{state.base_url}/session/#{session_id}/prompt_async"

    case http_post(url, body) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:abort_session, session_id}, _from, state) do
    case http_post("#{state.base_url}/session/#{session_id}/abort", %{}) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:revert_session, session_id}, _from, state) do
    case http_post("#{state.base_url}/session/#{session_id}/revert", %{}) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:reply_to_permission, session_id, permission_id, reply}, _from, state) do
    url = "#{state.base_url}/session/#{session_id}/permissions/#{permission_id}"

    case http_post(url, %{"response" => reply}) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:fetch_messages, session_id}, _from, state) do
    case http_get("#{state.base_url}/session/#{session_id}/message") do
      {:ok, %{"messages" => messages}} when is_list(messages) -> {:reply, {:ok, messages}, state}
      {:ok, messages} when is_list(messages) -> {:reply, {:ok, messages}, state}
      {:ok, _} -> {:reply, {:ok, []}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:get_session, session_id}, _from, state) do
    case http_get("#{state.base_url}/session/#{session_id}") do
      {:ok, data} -> {:reply, {:ok, data}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  # --- MCP operations ---

  @impl true
  def handle_call(:mcp_status, _from, state) do
    {:reply, http_get("#{state.base_url}/mcp"), state}
  end

  @impl true
  def handle_call({:mcp_add, name, config}, _from, state) do
    body = %{"name" => name, "config" => config}

    case http_post("#{state.base_url}/mcp", body) do
      {:ok, data} -> {:reply, {:ok, data}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:mcp_connect, name}, _from, state) do
    encoded = encode_path_segment(name)

    case http_post("#{state.base_url}/mcp/#{encoded}/connect", %{}) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call({:mcp_disconnect, name}, _from, state) do
    encoded = encode_path_segment(name)

    case http_post("#{state.base_url}/mcp/#{encoded}/disconnect", %{}) do
      {:ok, _} -> {:reply, :ok, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  @impl true
  def handle_call(:fetch_providers, _from, state) do
    case http_get("#{state.base_url}/provider") do
      {:ok, %{"all" => providers}} when is_list(providers) -> {:reply, {:ok, providers}, state}
      {:ok, providers} when is_list(providers) -> {:reply, {:ok, providers}, state}
      {:ok, _} -> {:reply, {:ok, []}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  # --- Unsubscribe (cast) ---

  @impl true
  def handle_cast({:unsubscribe, thread_id}, state) do
    case Map.pop(state.subscribers, thread_id) do
      {nil, _subscribers} ->
        # Already removed (DOWN handler won the race) — skip decrement
        {:noreply, state}

      {_pid, remaining} ->
        RuntimeRegistry.decrement_ref(state.runtime_key)
        maybe_schedule_idle_shutdown(%{state | subscribers: remaining})
    end
  end

  # --- Terminate ---

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopped: true}

    # Kill SSE listener
    if state.sse_pid && Process.alive?(state.sse_pid) do
      Process.exit(state.sse_pid, :shutdown)
    end

    # Kill opencode process
    if state.port do
      try do
        port_info = Port.info(state.port)

        if port_info do
          os_pid = Keyword.get(port_info, :os_pid)
          if os_pid, do: System.cmd("kill", [to_string(os_pid)], stderr_to_stdout: true)
        end

        Port.close(state.port)
      catch
        _, _ -> :ok
      end
    end

    # Clean up registry
    RuntimeRegistry.unregister(state.runtime_key)

    :ok
  end

  # --- Process Management (extracted from OpenCodeSession) ---

  defp resolve_opencode_binary(params) do
    provider_options = Map.get(params, "providerOptions", %{})
    opencode_options = Map.get(provider_options, "opencode", %{})

    Map.get(opencode_options, "binaryPath") ||
      System.find_executable("opencode") ||
      "opencode"
  end

  defp find_available_port do
    {:ok, socket} = :gen_tcp.listen(0, [{:reuseaddr, true}])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  defp spawn_opencode(state) do
    cwd = Map.get(state.params, "cwd", File.cwd!())

    args = [
      "serve",
      "--port",
      to_string(state.opencode_port),
      "--hostname",
      "127.0.0.1"
    ]

    try do
      port =
        Port.open(
          {:spawn_executable, to_charlist(state.binary_path)},
          [
            :binary,
            :exit_status,
            {:line, 65_536},
            {:cd, to_charlist(cwd)},
            {:args, Enum.map(args, &to_charlist/1)},
            {:env, build_env(state)}
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp build_env(state) do
    base =
      System.get_env()
      |> Enum.map(fn {k, v} -> {to_charlist(k), to_charlist(v)} end)

    opencode_config_path = get_in(state.params, ["providerOptions", "opencode", "configPath"])

    if is_binary(opencode_config_path) and opencode_config_path != "" do
      [{~c"OPENCODE_CONFIG", to_charlist(opencode_config_path)} | base]
    else
      base
    end
  end

  defp wait_for_server(_base_url, 0), do: {:error, :timeout}

  defp wait_for_server(base_url, attempts) do
    case http_get("#{base_url}/global/health") do
      {:ok, %{"healthy" => true}} ->
        :ok

      _ ->
        Process.sleep(1_000)
        wait_for_server(base_url, attempts - 1)
    end
  end

  # --- SSE Listener (extracted from OpenCodeSession) ---

  defp start_sse_listener(state) do
    parent = self()
    url = "#{state.base_url}/event"

    pid =
      spawn(fn ->
        sse_loop(parent, url)
      end)

    Process.monitor(pid)

    # Schedule periodic health checks
    Process.send_after(self(), :health_check, @health_check_interval_ms)

    pid
  end

  defp sse_loop(parent, url) do
    Logger.info("Runtime SSE connecting to #{url}")

    uri = URI.parse(url)
    host = uri.host || "127.0.0.1"
    port = uri.port || 80
    path = uri.path || "/event"

    request =
      "GET #{path} HTTP/1.1\r\nHost: #{host}:#{port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"

    case :gen_tcp.connect(to_charlist(host), port, [:binary, {:active, true}], 10_000) do
      {:ok, socket} ->
        :gen_tcp.send(socket, request)
        Logger.info("Runtime SSE connected, waiting for data...")
        sse_tcp_loop(parent, socket, "", false)

      {:error, reason} ->
        Logger.warning("Runtime SSE connection failed: #{inspect(reason)}")
        send(parent, {:sse_down, reason})
    end
  end

  defp sse_tcp_loop(parent, socket, buffer, headers_done) do
    receive do
      {:tcp, ^socket, data} ->
        full = buffer <> data

        {body, hd} =
          if headers_done do
            {full, true}
          else
            case String.split(full, "\r\n\r\n", parts: 2) do
              [_headers, rest] -> {rest, true}
              _ -> {full, false}
            end
          end

        if hd do
          {events, remaining} = extract_sse_data_lines(body)

          Enum.each(events, fn event ->
            send(parent, {:sse_event, event})
          end)

          sse_tcp_loop(parent, socket, remaining, true)
        else
          sse_tcp_loop(parent, socket, full, false)
        end

      {:tcp_closed, ^socket} ->
        send(parent, {:sse_down, :stream_end})

      {:tcp_error, ^socket, reason} ->
        send(parent, {:sse_down, reason})
    after
      120_000 ->
        send(parent, {:sse_down, :idle_timeout})
    end
  end

  defp extract_sse_data_lines(raw) do
    lines = Regex.scan(~r/data: (\{[^\n]+\})/, raw)

    events =
      Enum.flat_map(lines, fn
        [_full, json] ->
          case Jason.decode(json) do
            {:ok, %{"type" => type, "properties" => props}} ->
              [%{"type" => type, "data" => props}]

            {:ok, parsed} ->
              [%{"type" => Map.get(parsed, "type", "unknown"), "data" => parsed}]

            _ ->
              []
          end

        _ ->
          []
      end)

    remaining =
      case Regex.scan(~r/data: \{[^\n]+\}\n/, raw, return: :index) do
        [] ->
          raw

        matches ->
          {last_start, last_len} = List.last(List.last(matches))
          String.slice(raw, (last_start + last_len)..-1//1)
      end

    {events, remaining}
  end

  defp parse_sse_events(buffer) do
    parts = String.split(buffer, "\n\n")

    case parts do
      [single] ->
        {[], single}

      parts ->
        {complete, [remaining]} = Enum.split(parts, -1)

        events =
          Enum.flat_map(complete, fn part ->
            lines = String.split(part, "\n")

            event_type =
              Enum.find_value(lines, fn
                "event: " <> type -> String.trim(type)
                _ -> nil
              end)

            data =
              Enum.find_value(lines, fn
                "data: " <> json -> String.trim(json)
                _ -> nil
              end)

            if event_type && data do
              case Jason.decode(data) do
                {:ok, parsed} -> [%{"type" => event_type, "data" => parsed}]
                _ -> []
              end
            else
              []
            end
          end)

        {events, remaining}
    end
  end

  # --- Event Fanout ---

  defp fanout_event(state, event) do
    Enum.each(state.subscribers, fn {_thread_id, wrapper_pid} ->
      send(wrapper_pid, {:runtime_sse_event, event})
    end)
  end

  # --- SSE Reconnect with Backoff ---

  defp schedule_sse_reconnect(state, reason) do
    if state.stopped do
      {:noreply, %{state | sse_pid: nil}}
    else
      attempts = state.sse_reconnect_attempts + 1

      if attempts > @sse_max_retries do
        Logger.error(
          "Runtime SSE reconnect exhausted after #{attempts} attempts " <>
            "(key: #{RuntimeKey.to_string(state.runtime_key)})"
        )

        Enum.each(state.subscribers, fn {_thread_id, wrapper_pid} ->
          send(wrapper_pid, {:runtime_sse_degraded, self()})
        end)

        {:noreply, %{state | sse_pid: nil, health: :degraded, sse_reconnect_attempts: attempts}}
      else
        delay = sse_backoff_delay(attempts)

        Logger.warning(
          "Runtime SSE stopped: #{inspect(reason)}, " <>
            "reconnecting in #{delay}ms (attempt #{attempts}/#{@sse_max_retries})..."
        )

        Process.send_after(self(), :reconnect_sse, delay)
        {:noreply, %{state | sse_pid: nil, sse_reconnect_attempts: attempts}}
      end
    end
  end

  defp sse_backoff_delay(attempt) do
    base = @sse_initial_delay * :math.pow(@sse_backoff_multiplier, attempt - 1)
    capped = min(round(base), @sse_max_delay)
    jitter = :rand.uniform(max(div(capped, 10), 1))
    capped + jitter
  end

  # --- Idle TTL ---

  defp maybe_schedule_idle_shutdown(state) do
    ref_count = RuntimeRegistry.ref_count(state.runtime_key)

    if ref_count == 0 and map_size(state.subscribers) == 0 do
      state = cancel_idle_timer(state)
      timer_ref = Process.send_after(self(), :idle_shutdown, @idle_ttl_ms)
      {:noreply, %{state | idle_timer_ref: timer_ref}}
    else
      {:noreply, state}
    end
  end

  defp cancel_idle_timer(%{idle_timer_ref: nil} = state), do: state

  defp cancel_idle_timer(%{idle_timer_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | idle_timer_ref: nil}
  end

  # --- HTTP Client ---

  defp http_get(url) do
    case Req.get(url, receive_timeout: 10_000) do
      {:ok, %{status: status, body: body}} when status in 200..204 ->
        if is_map(body), do: {:ok, body}, else: Jason.decode(to_string(body))

      {:ok, %{status: status, body: body}} ->
        {:error, "HTTP #{status}: #{inspect(body) |> String.slice(0, 200)}"}

      {:error, reason} ->
        {:error, inspect(reason)}
    end
  end

  defp http_delete(url) do
    case Req.request(method: :delete, url: url, receive_timeout: 10_000) do
      {:ok, %{status: status}} when status in 200..204 ->
        {:ok, %{}}

      {:ok, %{status: status, body: body}} ->
        {:error, "HTTP #{status}: #{inspect(body) |> String.slice(0, 200)}"}

      {:error, reason} ->
        {:error, inspect(reason)}
    end
  end

  defp http_post(url, body) do
    case Req.post(url, json: body, receive_timeout: 30_000) do
      {:ok, %{status: status, body: body}} when status in 200..204 ->
        if is_map(body) do
          {:ok, body}
        else
          body_str = to_string(body || "")
          if body_str == "", do: {:ok, %{}}, else: Jason.decode(body_str)
        end

      {:ok, %{status: status, body: body}} ->
        {:error, "HTTP #{status}: #{inspect(body) |> String.slice(0, 200)}"}

      {:error, reason} ->
        {:error, inspect(reason)}
    end
  end

  defp encode_path_segment(value) when is_binary(value) do
    URI.encode(value, &URI.char_unreserved?/1)
  end

  # --- Starting a new runtime ---

  defp start_new_runtime_subscribed(key, params, thread_id, wrapper_pid) do
    child_spec = {__MODULE__, %{runtime_key: key, params: params}}

    case DynamicSupervisor.start_child(Harness.RuntimeSupervisor, child_spec) do
      {:ok, pid} ->
        case RuntimeRegistry.register(key, pid) do
          :ok ->
            # register/2 sets ref_count=1 — subscribe without incrementing
            GenServer.call(pid, {:subscribe_initial, thread_id, wrapper_pid})
            {:ok, pid}

          {:error, :already_registered} ->
            # Race: another thread registered between our lookup and register.
            # Kill ours and retry via the caller's retry loop.
            DynamicSupervisor.terminate_child(Harness.RuntimeSupervisor, pid)
            {:error, {:registration_race, RuntimeKey.to_string(key)}}
        end

      {:error, reason} ->
        {:error, {:runtime_start_failed, reason}}
    end
  end
end
