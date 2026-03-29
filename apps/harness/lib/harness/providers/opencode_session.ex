defmodule Harness.Providers.OpenCodeSession do
  @moduledoc """
  GenServer managing a single OpenCode session.

  OpenCode uses HTTP REST + SSE (not stdio like Codex/Claude):
  - `opencode serve --port PORT` starts a headless HTTP server
  - `POST /session` creates sessions
  - `POST /session/:id/prompt_async` sends messages (returns 204, streams via SSE)
  - `GET /event` provides SSE stream for all real-time events
  - `POST /session/:id/permissions/:permissionID` resolves approval requests

  This GenServer:
  1. Spawns `opencode serve` as a child process
  2. Connects to its SSE event stream
  3. Creates a session via HTTP
  4. Sends turns via prompt_async
  5. Translates OpenCode events to harness events

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

  require Logger

  @sse_reconnect_delay 1_000

  defstruct [
    :thread_id,
    :provider,
    :event_callback,
    :params,
    :port,
    :opencode_port,
    :opencode_session_id,
    :sse_pid,
    :base_url,
    :binary_path,
    :mcp_config,
    turn_state: nil,
    pending_permissions: %{},
    messages: [],
    sse_buffer: "",
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

    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: "opencode",
      event_callback: Map.fetch!(opts, :event_callback),
      params: params,
      binary_path: resolve_opencode_binary(opts),
      opencode_port: find_available_port(),
      opencode_session_id: persisted_session_id,
      mcp_config: Map.get(params, "mcp_config")
    }

    state = %{state | base_url: "http://127.0.0.1:#{state.opencode_port}"}

    case spawn_opencode(state) do
      {:ok, port} ->
        state = %{state | port: port}

        # Wait for server to be ready, then connect SSE and create session
        send(self(), :setup)
        {:ok, state}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_info(:setup, state) do
    # Wait for OpenCode server to be ready
    case wait_for_server(state.base_url, 45) do
      :ok ->
        # Connect to SSE event stream
        sse_connected_at = System.monotonic_time(:millisecond)
        sse_pid = start_sse_listener(state)
        state = %{state | sse_pid: sse_pid, sse_connected_at: sse_connected_at}

        Logger.info(
          "[H4-TIMING] SSE connect initiated at mono=#{sse_connected_at}ms for thread #{state.thread_id}"
        )

        # Reuse a persisted session when available; otherwise create a new one.
        # This preserves conversation history across session restarts/resumes.
        {session_result, _reused} =
          if state.opencode_session_id do
            # Verify the persisted session still exists on the server
            case verify_opencode_session(state) do
              :ok ->
                Logger.info(
                  "Reusing persisted OpenCode session #{state.opencode_session_id} for thread #{state.thread_id}"
                )

                {{:ok, state.opencode_session_id}, true}

              {:error, reason} ->
                Logger.info(
                  "Persisted OpenCode session invalid (#{inspect(reason)}), creating new session for thread #{state.thread_id}"
                )

                {create_opencode_session(state), false}
            end
          else
            {create_opencode_session(state), false}
          end

        case session_result do
          {:ok, session_id} ->
            state = %{state | opencode_session_id: session_id, ready: true}

            # Hydrate message history from server on resume so read_thread
            # returns prior turns even after GenServer crash/restart.
            state =
              case fetch_server_messages(state) do
                {:ok, msgs} when msgs != [] ->
                  turns = server_messages_to_turns(msgs)
                  Logger.info("Hydrated #{length(turns)} turns from server for thread #{state.thread_id}")
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

      {:error, :timeout} ->
        Logger.error("OpenCode server failed to start on port #{state.opencode_port}")
        {:stop, :server_timeout, state}
    end
  end

  # Port exit (opencode process died)
  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    unless state.stopped do
      Logger.info("OpenCode process exited with status #{status} for thread #{state.thread_id}")

      state = maybe_complete_turn(state, if(status == 0, do: "completed", else: "failed"))

      emit_event(state, :session, "session/exited", %{
        "exitStatus" => status,
        "exitKind" => if(status == 0, do: "graceful", else: "error")
      })
    end

    {:stop, :normal, state}
  end

  # SSE chunks from the Req streaming listener
  @impl true
  def handle_info({:sse_chunk, chunk}, state) do
    buffer = (state.sse_buffer || "") <> chunk
    {events, remaining} = parse_sse_events(buffer)
    state = %{state | sse_buffer: remaining}

    state =
      Enum.reduce(events, state, fn event, acc ->
        handle_sse_event(event, acc)
      end)

    {:noreply, state}
  end

  # Legacy SSE event format (from previous implementation)
  @impl true
  def handle_info({:sse_event, event}, state) do
    state = handle_sse_event(event, state)
    {:noreply, state}
  end

  # SSE listener died (explicit message)
  @impl true
  def handle_info({:sse_down, reason}, state) do
    unless state.stopped do
      Logger.warning("SSE listener stopped: #{inspect(reason)}, reconnecting...")
      Process.send_after(self(), :reconnect_sse, @sse_reconnect_delay)
    end

    {:noreply, %{state | sse_pid: nil}}
  end

  # SSE listener process died (monitor DOWN)
  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, %{sse_pid: pid} = state) do
    unless state.stopped do
      Logger.warning("SSE process died: #{inspect(reason)}, reconnecting...")
      Process.send_after(self(), :reconnect_sse, @sse_reconnect_delay)
    end

    {:noreply, %{state | sse_pid: nil}}
  end

  @impl true
  def handle_info(:reconnect_sse, %{stopped: false} = state) do
    reconnect_at = System.monotonic_time(:millisecond)

    Logger.info(
      "[H4-TIMING] SSE reconnect at mono=#{reconnect_at}ms for thread #{state.thread_id}"
    )

    sse_pid = start_sse_listener(state)
    # Reset timing state for the new SSE connection so we capture the gap on resume
    {:noreply,
     %{state | sse_pid: sse_pid, sse_connected_at: reconnect_at, permission_timing_logged: false}}
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

  # --- Diagnostics ---

  @impl true
  def handle_call(:get_diagnostics, _from, state) do
    alias Harness.Dev.DiagnosticsHelpers, as: DH

    diagnostics = %{
      thread_id: state.thread_id,
      provider: state.provider,
      opencode_port: state.opencode_port,
      opencode_session_id: state.opencode_session_id,
      base_url: state.base_url,
      binary_path: state.binary_path,
      ready: state.ready,
      stopped: state.stopped,
      reasoning_active: state.reasoning_active,
      port_alive: DH.port_alive?(state.port),
      sse_alive: state.sse_pid != nil and Process.alive?(state.sse_pid),
      turn_state: DH.sanitize_turn_state(state.turn_state),
      pending_permissions_count: map_size(state.pending_permissions),
      message_count: length(state.messages),
      sse_buffer_bytes: byte_size(state.sse_buffer || "")
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

    # Send via prompt_async (non-blocking)
    case send_prompt_async(state, text, params) do
      :ok ->
        resume_cursor =
          Jason.encode!(%{
            "threadId" => state.thread_id,
            "sessionId" => state.opencode_session_id,
            "port" => state.opencode_port
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
    # Abort the session
    abort_session(state)
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

        case reply_to_permission(state, Map.get(pending, :permission_id), reply) do
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

          reply_to_permission(state, permission_id, answer_text)
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
      if state.messages == [] and state.opencode_session_id do
        case fetch_server_messages(state) do
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

  # --- MCP Management ---

  @impl true
  def handle_call(:mcp_status, _from, state) do
    result =
      case http_get("#{state.base_url}/mcp") do
        {:ok, data} -> {:ok, data}
        {:error, reason} -> {:error, reason}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_add, name, config}, _from, state) do
    body = Map.merge(%{"name" => name}, config)

    result =
      case http_post("#{state.base_url}/mcp", body) do
        {:ok, data} -> {:ok, data}
        {:error, reason} -> {:error, reason}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_connect, name}, _from, state) do
    result =
      case http_post("#{state.base_url}/mcp/#{name}/connect", %{}) do
        {:ok, _} -> :ok
        {:error, reason} -> {:error, reason}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:mcp_disconnect, name}, _from, state) do
    result =
      case http_post("#{state.base_url}/mcp/#{name}/disconnect", %{}) do
        {:ok, _} -> :ok
        {:error, reason} -> {:error, reason}
      end

    {:reply, result, state}
  end

  # --- List Models (HTTP-based discovery) ---

  @impl true
  def handle_call(:list_models, _from, state) do
    result =
      case fetch_providers(state) do
        {:ok, providers} -> {:ok, extract_models_from_providers(providers)}
        {:error, reason} -> {:error, reason}
      end

    {:reply, result, state}
  end

  # --- Rollback ---

  @impl true
  def handle_call({:rollback_thread, num_turns}, _from, state) do
    messages = if num_turns > 0, do: Enum.drop(state.messages, -num_turns), else: state.messages
    state = %{state | messages: messages}

    # Revert via OpenCode API if session exists
    if state.opencode_session_id && num_turns > 0 do
      revert_session(state)
    end

    {:reply, {:ok, %{threadId: state.thread_id, turns: []}}, state}
  end

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopped: true}
    emit_event(state, :session, "session/closed", %{})

    # Cancel pending approvals/elicitations so SQLite rows are cleaned up
    cancel_all_pending(state)

    # Best-effort cleanup: delete the OpenCode session from the server's SQLite DB
    # so sessions don't accumulate across restarts.
    try do
      delete_session(state)
    rescue
      _ -> :ok
    catch
      _, _ -> :ok
    end

    # Reject ready waiters
    Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, "Session terminated"}))

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

    :ok
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

  # --- Process Management ---

  defp resolve_opencode_binary(opts) do
    params = Map.get(opts, :params, %{})
    provider_options = Map.get(params, "providerOptions", %{})
    opencode_options = Map.get(provider_options, "opencode", %{})

    Map.get(opencode_options, "binaryPath") ||
      System.find_executable("opencode") ||
      "opencode"
  end

  defp find_available_port do
    # Get a random available port. There is an inherent TOCTOU window between
    # closing the probe socket and opencode binding the port — acceptable for dev,
    # but use reuseaddr to minimize the window on retries.
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

  # --- SSE Listener ---

  defp start_sse_listener(state) do
    parent = self()
    url = "#{state.base_url}/event"

    pid =
      spawn(fn ->
        sse_loop(parent, url)
      end)

    # Monitor instead of link — crash won't kill GenServer
    Process.monitor(pid)
    pid
  end

  defp sse_loop(parent, url) do
    Logger.info("SSE connecting to #{url}")

    uri = URI.parse(url)
    host = uri.host || "127.0.0.1"
    port = uri.port || 80
    path = uri.path || "/event"

    # Raw TCP with active mode — most reliable for SSE streaming
    request =
      "GET #{path} HTTP/1.1\r\nHost: #{host}:#{port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n"

    case :gen_tcp.connect(to_charlist(host), port, [:binary, {:active, true}], 10_000) do
      {:ok, socket} ->
        :gen_tcp.send(socket, request)
        Logger.info("SSE connected, waiting for data...")
        sse_tcp_loop(parent, socket, "", false)

      {:error, reason} ->
        Logger.warning("SSE connection failed: #{inspect(reason)}")
        send(parent, {:sse_down, reason})
    end
  end

  defp sse_tcp_loop(parent, socket, buffer, headers_done) do
    receive do
      {:tcp, ^socket, data} ->
        Logger.debug(
          "SSE raw data (#{byte_size(data)} bytes): #{inspect(String.slice(data, 0, 200))}"
        )

        full = buffer <> data

        # Strip HTTP headers from first data
        {body, hd} =
          if headers_done do
            {full, true}
          else
            case String.split(full, "\r\n\r\n", parts: 2) do
              [_headers, rest] ->
                Logger.info("SSE headers stripped, streaming events...")
                {rest, true}

              _ ->
                {full, false}
            end
          end

        if hd do
          # Extract SSE events directly from raw data (handles chunked encoding)
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

  # Extract SSE data lines from raw TCP data (works with chunked encoding).
  # Scans for "data: {json}\n" patterns regardless of chunked framing.
  defp extract_sse_data_lines(raw) do
    # Find all complete "data: ...\n" lines using regex
    # SSE format: "data: {json}\n\n" — we look for "data: " prefix
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

    # Keep any trailing incomplete data as buffer
    # Find the last complete "data: ...\n" and keep everything after
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
    # SSE format: "event: type\ndata: json\n\n"
    parts = String.split(buffer, "\n\n")

    case parts do
      [single] ->
        # No complete event yet
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
    # mode. When a "text" part starts, exit reasoning mode. This allows
    # message.part.delta events (which all arrive with field="text") to be
    # correctly classified as reasoning vs assistant text.
    state =
      cond do
        part_type in ["reasoning", "thinking"] ->
          %{state | reasoning_active: true}

        part_type == "step" ->
          # A "step" part often carries reasoning/thinking content
          %{state | reasoning_active: true}

        part_type == "text" ->
          %{state | reasoning_active: false}

        part_type == "tool" ->
          # Tool execution is not reasoning
          %{state | reasoning_active: false}

        true ->
          state
      end

    turn_id = turn_id_from_state(state)

    case part_type do
      "tool" ->
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
            # Stream tool output as content/delta before completing the item
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

      "text" ->
        # Full text arrives here but message.part.delta already streams it.
        # Emitting again would duplicate the text in the assistant message.
        :ok

      "subtask" ->
        # OpenCode subagent task spawned (e.g. Explore, General, custom agent)
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

      "agent" ->
        # Agent switch (e.g. Build → Plan, or primary → subagent)
        agent_name = Map.get(part, "name", "unknown")
        Logger.info("OpenCode agent switch: #{agent_name}")

        emit_event(state, :notification, "session/state-changed", %{
          "state" => "running",
          "agent" => agent_name,
          "turnId" => turn_id
        })

      "step-start" ->
        # Agent step lifecycle — maps to item/started for work log tracking.
        # Extract tool name from the step part when available (e.g. "read", "grep",
        # "bash"), falling back to "step" for generic steps.
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

      "step-finish" ->
        # Use part.id when available. When omitted (OpenCode sometimes drops IDs
        # on finish), fall back to a synthetic ID so the UI clears the step.
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

      _ ->
        :ok
    end

    state
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
        # Don't try to complete turn here — session.status → idle handles that.
        # The "finish" key was never present in OpenCode's message.updated events,
        # so this path never fired. Turn completion is reliably handled by
        # handle_sse_event(%{"type" => "session.status"}) → "idle".
        state
    end
  end

  defp handle_sse_event(%{"type" => "permission.asked", "data" => data}, state) do
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
      reply_to_permission(state, permission_id, "always")
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
    # Note: do NOT emit session/state-changed → running here.
    # session.status → busy already handles that, and session.updated can arrive
    # AFTER session.status → idle, which would reset the sidebar back to "Working"
    # and leave it stuck there permanently.
    state
  end

  # session.status carries the OpenCode-native status (busy/idle)
  defp handle_sse_event(%{"type" => "session.status", "data" => data}, state) do
    status_type = get_in(data, ["status", "type"])

    case status_type do
      "idle" ->
        # Complete the turn — maybe_complete_turn emits both
        # turn/completed and session/state-changed → ready internally.
        # Always emit ready afterwards for the case where turn_state is
        # already nil (e.g. session.idle arrived after another path
        # already completed the turn).
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

  # session.idle means OpenCode finished processing — treat as turn completion
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

  # --- HTTP Client (Req — handles chunked encoding, redirects, etc.) ---

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
      {:ok, %{status: status}} when status in 200..204 -> {:ok, %{}}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body) |> String.slice(0, 200)}"}
      {:error, reason} -> {:error, inspect(reason)}
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

  # Extract a persisted OpenCode sessionId from resumeCursor params.
  # Accepts both JSON-string and already-decoded map forms (see D4).
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

  # Verify that a persisted OpenCode session still exists on the server.
  defp verify_opencode_session(state) do
    case http_get("#{state.base_url}/session/#{state.opencode_session_id}") do
      {:ok, %{"id" => id}} when id == state.opencode_session_id -> :ok
      {:ok, body} -> {:error, {:unexpected_session_payload, body}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp create_opencode_session(state) do
    case http_post("#{state.base_url}/session", %{"title" => "harness-#{state.thread_id}"}) do
      {:ok, %{"id" => id}} -> {:ok, id}
      {:ok, session} -> {:ok, Map.get(session, "id", generate_id())}
      {:error, reason} -> {:error, reason}
    end
  end

  defp send_prompt_async(state, text, params) do
    url = "#{state.base_url}/session/#{state.opencode_session_id}/prompt_async"
    # OpenCode's prompt_async only accepts {"parts": [...]}
    # The model field is NOT accepted here (causes HTTP 400).
    # Model is set at session creation time, not per-prompt.
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

    body = %{
      "parts" => text_parts ++ image_parts
    }

    case http_post(url, body) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp abort_session(state) do
    if state.opencode_session_id do
      http_post("#{state.base_url}/session/#{state.opencode_session_id}/abort", %{})
    end
  end

  # Fetch providers from the OpenCode server's GET /provider endpoint.
  # Returns {:ok, provider_map} or {:error, reason}.
  defp fetch_providers(state) do
    case http_get("#{state.base_url}/provider") do
      {:ok, %{"all" => providers}} when is_map(providers) ->
        {:ok, providers}

      {:ok, providers} when is_map(providers) ->
        {:ok, providers}

      {:ok, _} ->
        {:ok, %{}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Extract a flat list of %{"slug" => "provider/model", "name" => "..."} from the
  # provider map returned by GET /provider.
  defp extract_models_from_providers(providers) when is_map(providers) do
    Enum.flat_map(providers, fn {provider_key, provider_data} ->
      models = Map.get(provider_data, "models", %{})

      if is_map(models) do
        Enum.map(models, fn {model_key, model_data} ->
          slug = "#{provider_key}/#{model_key}"
          name = Map.get(model_data, "name", model_key)
          %{"slug" => slug, "name" => name}
        end)
      else
        []
      end
    end)
  end

  defp extract_models_from_providers(_), do: []

  # Fetch message history from the OpenCode server for the current session.
  # Returns {:ok, messages} on success or {:ok, []} on any failure (never crashes).
  defp fetch_server_messages(state) do
    if state.opencode_session_id do
      case http_get("#{state.base_url}/session/#{state.opencode_session_id}/message") do
        {:ok, %{"messages" => messages}} when is_list(messages) ->
          {:ok, messages}

        {:ok, messages} when is_list(messages) ->
          {:ok, messages}

        {:ok, _} ->
          {:ok, []}

        {:error, reason} ->
          Logger.warning("Failed to fetch server messages for session #{state.opencode_session_id}: #{inspect(reason)}")
          {:ok, []}
      end
    else
      {:ok, []}
    end
  end

  # Convert server-side messages into the in-memory turn buffer shape
  # used by read_thread. Filters for assistant-role messages only.
  defp server_messages_to_turns(messages) when is_list(messages) do
    messages
    |> Enum.filter(fn msg -> Map.get(msg, "role") == "assistant" end)
    |> Enum.map(fn msg ->
      %{
        turn_id: Map.get(msg, "id", generate_id()),
        started_at: Map.get(msg, "createdAt", now_iso()),
        items:
          (Map.get(msg, "parts", []) || [])
          |> Enum.flat_map(fn part ->
            case Map.get(part, "type") do
              "text" ->
                text = Map.get(part, "text", "")
                if text != "", do: [%{"type" => "text", "text" => text}], else: []

              "tool" ->
                [%{
                  "type" => "tool",
                  "tool" => Map.get(part, "tool", "unknown"),
                  "state" => Map.get(part, "state", %{})
                }]

              _ ->
                []
            end
          end)
      }
    end)
  end

  defp server_messages_to_turns(_), do: []

  defp delete_session(state) do
    if state.opencode_session_id do
      case http_delete("#{state.base_url}/session/#{state.opencode_session_id}") do
        {:ok, _} ->
          Logger.info("Deleted OpenCode session #{state.opencode_session_id} for thread #{state.thread_id}")

        {:error, reason} ->
          Logger.warning("Failed to delete OpenCode session #{state.opencode_session_id}: #{inspect(reason)}")
      end
    end
  end

  defp revert_session(state) do
    if state.opencode_session_id do
      http_post("#{state.base_url}/session/#{state.opencode_session_id}/revert", %{})
    end
  end

  defp reply_to_permission(state, permission_id, reply) do
    url = "#{state.base_url}/session/#{state.opencode_session_id}/permissions/#{permission_id}"

    case http_post(url, %{"response" => reply}) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
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

    # Emit ready state so the sidebar clears the "Working" badge
    emit_event(state, :session, "session/state-changed", %{"state" => "ready"})

    %{state | turn_state: nil, messages: state.messages ++ [turn]}
  end

  # --- Helpers ---

  defp turn_id_from_state(%{turn_state: %{turn_id: turn_id}}), do: turn_id
  defp turn_id_from_state(_), do: nil

  defp persist_binding(state) do
    # Only persist durable identifiers — port is ephemeral and stale after restart
    cursor_json =
      Jason.encode!(%{
        "threadId" => state.thread_id,
        "sessionId" => state.opencode_session_id
      })

    Harness.Storage.upsert_binding(state.thread_id, state.provider, cursor_json)
  end

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

  # Extract a human-readable detail from an OpenCode tool part.
  # OpenCode tool parts: {"tool":"bash","state":{"status":"running","input":{"command":"ls /tmp"}}}
  defp extract_tool_detail(part) do
    input = get_in(part, ["state", "input"]) || %{}
    # Common input patterns across OpenCode tools
    Map.get(input, "command") ||
      Map.get(input, "file_path") ||
      Map.get(input, "filePath") ||
      Map.get(input, "path") ||
      Map.get(input, "query") ||
      Map.get(input, "pattern") ||
      Map.get(part, "tool")
  end

  # Extract tool output as a string for streaming via content/delta.
  # OpenCode stores results in state.output (confirmed via live SSE capture)
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

  # Extract structured tool output for item/completed events.
  # Returns the full output/result in its original form (map, list, or string)
  # so the UI can render rich tool results (e.g. file diffs, command stdout/stderr).
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
