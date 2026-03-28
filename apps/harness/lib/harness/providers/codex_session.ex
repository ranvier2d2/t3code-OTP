defmodule Harness.Providers.CodexSession do
  @moduledoc """
  GenServer managing a single Codex app-server process.

  Replaces CodexAppServerManager from the Node codebase.
  Spawns `codex app-server` via Erlang Port, speaks JSON-RPC 2.0 over stdio.

  Feature parity with Node adapter:
  - Version checking (minimum 0.37.0)
  - Account/Spark model gating
  - Plan mode collaboration construction
  - Binary path + CODEX_HOME support
  - Fast mode / service tier mapping
  - Thread resume with recoverable error fallback
  - Collab child conversation suppression
  """
  use GenServer, restart: :temporary
  @behaviour Harness.ProviderSession

  alias Harness.JsonRpc
  alias Harness.Event

  require Logger

  @minimum_codex_version {0, 37, 0}
  @version_check_timeout_ms 4_000
  @request_timeout 20_000
  @codex_default_model "gpt-5.3-codex"
  @codex_spark_model "gpt-5.3-codex-spark"
  @spark_disabled_plan_types MapSet.new(["free", "go", "plus"])

  @recoverable_resume_errors [
    "not found",
    "missing thread",
    "no such thread",
    "unknown thread",
    "does not exist"
  ]

  @suppressed_child_methods MapSet.new([
                              "thread/started",
                              "thread/status/changed",
                              "thread/archived",
                              "thread/unarchived",
                              "thread/closed",
                              "thread/compacted",
                              "thread/name/updated",
                              "thread/tokenUsage/updated",
                              "turn/started",
                              "turn/completed",
                              "turn/aborted",
                              "turn/plan/updated",
                              "item/plan/delta"
                            ])

  # Plan mode developer instructions (ported from codexAppServerManager.ts)
  @plan_mode_instructions """
  <collaboration_mode># Plan Mode (Conversational)

  You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

  ## Mode rules (strict)

  You are in **Plan Mode** until a developer message explicitly ends it. Plan Mode is not changed by user intent, tone, or imperative language.

  ## Execution vs. mutation in Plan Mode

  You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

  ## Finalization rule

  Only output the final plan when it is decision complete. Wrap it in a `<proposed_plan>` block.
  </collaboration_mode>
  """

  @default_mode_instructions """
  <collaboration_mode># Collaboration Mode: Default

  You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

  In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.
  </collaboration_mode>
  """

  defstruct [
    :thread_id,
    :provider,
    :port,
    :event_callback,
    :params,
    :buffer,
    :codex_thread_id,
    :binary_path,
    :codex_home,
    account: nil,
    next_id: 1,
    pending: %{},
    stopping: false,
    ready: false,
    ready_waiters: [],
    collab_receiver_turns: %{}
  ]

  # --- Public API ---

  def start_link(opts) do
    thread_id = Map.fetch!(opts, :thread_id)

    GenServer.start_link(__MODULE__, opts,
      name:
        {:via, Registry, {Harness.SessionRegistry, thread_id, Map.get(opts, :provider, "codex")}}
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
    params = Map.get(opts, :params, %{})
    binary_path = resolve_codex_binary(opts)
    codex_home = resolve_codex_home(params)

    state = %__MODULE__{
      thread_id: Map.fetch!(opts, :thread_id),
      provider: Map.get(opts, :provider, "codex"),
      event_callback: Map.fetch!(opts, :event_callback),
      params: params,
      buffer: "",
      binary_path: binary_path,
      codex_home: codex_home
    }

    # Version check before spawning
    case assert_codex_version(binary_path, codex_home) do
      :ok ->
        case spawn_codex(state) do
          {:ok, port} ->
            new_state = %{state | port: port}
            send(self(), :initialize)
            {:ok, new_state}

          {:error, reason} ->
            {:stop, reason}
        end

      {:error, message} ->
        Logger.error("Codex version check failed: #{message}")
        {:stop, {:version_check_failed, message}}
    end
  end

  @impl true
  def handle_info(:initialize, state) do
    {id, state} = next_request_id(state)

    codex_opts = get_in(state.params, ["providerOptions", "codex"]) || %{}
    experimental_api = Map.get(codex_opts, "experimentalApi", false)

    capabilities =
      if experimental_api do
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

  # Account read (after initialize, before thread start)
  @impl true
  def handle_info(:read_account, state) do
    {id, state} = next_request_id(state)
    state = send_rpc_request(state, id, "account/read", %{}, nil)
    pending_entry = Map.get(state.pending, id)
    state = put_in(state.pending[id], %{pending_entry | method: "account/read"})
    {:noreply, state}
  end

  # Port data received (stdout from codex process)
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

  # Fallback for raw binary data
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
        if from, do: GenServer.reply(from, {:error, "Request timeout"})
        {:noreply, %{state | pending: pending}}
    end
  end

  # Thread start (after initialize + account read)
  @impl true
  def handle_info(:start_thread, state) do
    {id, state} = next_request_id(state)
    resume_cursor = get_in(state.params, ["resumeCursor"])

    {method, params} =
      if resume_cursor do
        {"thread/resume",
         %{
           "threadId" => resume_cursor,
           "overrides" => thread_overrides(state)
         }}
      else
        {"thread/start", thread_overrides(state)}
      end

    state = send_rpc_request(state, id, method, params, nil)

    # Tag the pending entry so we can handle the response
    pending_entry = Map.get(state.pending, id)
    state = put_in(state.pending[id], %{pending_entry | method: method})

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
  def handle_call(:get_diagnostics, _from, state) do
    alias Harness.Dev.DiagnosticsHelpers, as: DH

    diagnostics = %{
      thread_id: state.thread_id,
      provider: state.provider,
      ready: state.ready,
      stopping: state.stopping,
      codex_thread_id: state.codex_thread_id,
      binary_path: state.binary_path,
      codex_home: state.codex_home,
      account: DH.sanitize_account(state.account),
      port_alive: DH.port_alive?(state.port),
      next_request_id: state.next_id,
      pending_count: map_size(state.pending),
      pending_methods: DH.pending_methods(state.pending),
      collab_receiver_count: map_size(state.collab_receiver_turns),
      buffer_bytes: byte_size(state.buffer || "")
    }

    {:reply, {:ok, diagnostics}, state}
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

    # Resolve model with account gating
    model = Map.get(params, "model")
    resolved_model = resolve_model_for_account(model, state.account)

    # Map modelOptions
    codex_model_opts = get_in(params, ["modelOptions", "codex"]) || %{}
    service_tier = if Map.get(codex_model_opts, "fastMode"), do: "fast", else: nil
    effort = Map.get(codex_model_opts, "reasoningEffort") || Map.get(params, "effort")

    # Build collaboration mode from interactionMode
    collaboration_mode = build_collaboration_mode(params, resolved_model, effort)

    turn_params =
      %{
        "threadId" => codex_tid,
        "input" => codex_input,
        "model" => resolved_model,
        "effort" => effort,
        "serviceTier" => service_tier,
        "collaborationMode" => collaboration_mode
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
    case find_pending_approval(state, request_id) do
      {rpc_id, _request} ->
        response = JsonRpc.encode_response(rpc_id, %{"decision" => decision})
        send_to_port(state, response)

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
    case find_pending_approval(state, request_id) do
      {rpc_id, _request} ->
        response = JsonRpc.encode_response(rpc_id, %{"answers" => answers})
        send_to_port(state, response)

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
  def handle_call({:read_thread, thread_id}, from, state) do
    {id, state} = next_request_id(state)

    state =
      send_rpc_request(
        state,
        id,
        "thread/read",
        %{"threadId" => thread_id, "includeTurns" => true},
        from
      )

    {:noreply, state}
  end

  @impl true
  def handle_call({:rollback_thread, thread_id, num_turns}, from, state) do
    {id, state} = next_request_id(state)

    state =
      send_rpc_request(
        state,
        id,
        "thread/rollback",
        %{"threadId" => thread_id, "numTurns" => num_turns},
        from
      )

    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    state = %{state | stopping: true}
    emit_event(state, :session, "session/closed", %{})

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

  # --- Version Checking ---

  defp assert_codex_version(binary_path, codex_home) do
    env = if codex_home, do: [{"CODEX_HOME", codex_home}], else: []

    task =
      Task.async(fn ->
        try do
          System.cmd(binary_path, ["--version"], env: env, stderr_to_stdout: true)
        rescue
          e -> {:rescue, e}
        end
      end)

    result = Task.yield(task, @version_check_timeout_ms)

    result =
      case result do
        nil -> Task.shutdown(task)
        other -> other
      end

    case result do
      {:ok, {:rescue, %ErlangError{original: :enoent}}} ->
        {:error, "Codex CLI is not installed or not executable at: #{binary_path}"}

      {:ok, {:rescue, e}} ->
        {:error, "Codex CLI version check failed: #{inspect(e)}"}

      {:ok, {output, 0}} ->
        case parse_codex_version(output) do
          {:ok, version} ->
            if version_supported?(version) do
              :ok
            else
              {:error, format_upgrade_message(version)}
            end

          :error ->
            {:error,
             "Could not parse Codex CLI version from output: #{String.slice(output, 0, 200)}"}
        end

      {:ok, {output, code}} ->
        {:error,
         "Codex CLI version check failed (exit #{code}): #{String.slice(output, 0, 200)}"}

      {:exit, reason} ->
        {:error, "Codex CLI version check task exited: #{inspect(reason)}"}

      nil ->
        {:error, "Codex CLI version check timed out after #{@version_check_timeout_ms}ms"}
    end
  end

  @version_regex ~r/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/

  defp parse_codex_version(output) do
    case Regex.run(@version_regex, output) do
      [_, version_str] ->
        parts = String.split(version_str, "-", parts: 2)
        core = hd(parts)
        prerelease = if length(parts) > 1, do: Enum.at(parts, 1), else: nil

        segments = String.split(core, ".") |> Enum.map(&String.to_integer/1)

        case segments do
          [major, minor] -> {:ok, {major, minor, 0, prerelease}}
          [major, minor, patch] -> {:ok, {major, minor, patch, prerelease}}
          _ -> :error
        end

      _ ->
        :error
    end
  rescue
    _ -> :error
  end

  defp version_supported?({major, minor, patch, prerelease}) do
    {min_major, min_minor, min_patch} = @minimum_codex_version

    cond do
      major > min_major -> true
      major < min_major -> false
      minor > min_minor -> true
      minor < min_minor -> false
      patch > min_patch -> true
      patch < min_patch -> false
      # Equal core version: prerelease < release
      prerelease != nil -> false
      true -> true
    end
  end

  defp format_upgrade_message({major, minor, patch, prerelease}) do
    version_str = "#{major}.#{minor}.#{patch}" <> if(prerelease, do: "-#{prerelease}", else: "")
    {min_major, min_minor, min_patch} = @minimum_codex_version

    "Codex CLI v#{version_str} is too old. Upgrade to v#{min_major}.#{min_minor}.#{min_patch} or newer and restart."
  end

  # --- Binary Path Resolution ---

  defp resolve_codex_binary(opts) do
    params = Map.get(opts, :params, %{})
    codex_options = get_in(params, ["providerOptions", "codex"]) || %{}

    Map.get(codex_options, "binaryPath") ||
      System.find_executable("codex") ||
      "codex"
  end

  defp resolve_codex_home(params) do
    codex_options = get_in(params, ["providerOptions", "codex"]) || %{}
    Map.get(codex_options, "homePath")
  end

  # --- Account / Spark Gating ---

  defp parse_account_snapshot(response) do
    account = get_in(response, ["account"]) || response || %{}
    account_type = Map.get(account, "type")

    case account_type do
      "apiKey" ->
        %{type: "apiKey", plan_type: nil, spark_enabled: true}

      "chatgpt" ->
        plan_type = Map.get(account, "planType", "unknown")

        %{
          type: "chatgpt",
          plan_type: plan_type,
          spark_enabled: not MapSet.member?(@spark_disabled_plan_types, plan_type)
        }

      _ ->
        %{type: "unknown", plan_type: nil, spark_enabled: true}
    end
  end

  defp resolve_model_for_account(model, account) do
    cond do
      model != @codex_spark_model -> model
      account == nil -> model
      account.spark_enabled -> model
      true -> @codex_default_model
    end
  end

  # --- Collaboration Mode ---

  defp build_collaboration_mode(params, model, effort) do
    case Map.get(params, "interactionMode") do
      nil ->
        nil

      mode ->
        instructions =
          if mode == "plan",
            do: @plan_mode_instructions,
            else: @default_mode_instructions

        %{
          "mode" => mode,
          "settings" => %{
            "model" => model || @codex_default_model,
            "reasoning_effort" => effort || "medium",
            "developer_instructions" => instructions
          }
        }
    end
  end

  # --- Port/Process Management ---

  defp spawn_codex(state) do
    env = build_codex_env(state.codex_home)

    try do
      port =
        Port.open(
          {:spawn_executable, to_charlist(state.binary_path)},
          [
            :binary,
            :exit_status,
            :use_stdio,
            :stderr_to_stdout,
            args: [~c"app-server"],
            line: 65_536,
            env: env
          ]
        )

      {:ok, port}
    rescue
      e -> {:error, Exception.message(e)}
    end
  end

  defp build_codex_env(codex_home) do
    base =
      System.get_env()
      |> Enum.map(fn {k, v} -> {to_charlist(k), to_charlist(v)} end)

    if codex_home do
      [{~c"CODEX_HOME", to_charlist(codex_home)} | base]
    else
      base
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
        state = %{state | pending: pending}
        send_to_port(state, JsonRpc.encode_notification("initialized"))
        emit_event(state, :session, "session/ready", %{})

        # Read account status before starting thread
        send(self(), :read_account)
        state

      {%{from: nil, method: "account/read"}, pending} ->
        # Parse account and store, then start thread
        state = %{state | pending: pending, account: parse_account_snapshot(result)}
        Logger.info("Codex account: #{inspect(state.account)}")
        send(self(), :start_thread)
        state

      {%{from: nil, method: "thread/start"}, pending} ->
        codex_id = get_in(result, ["thread", "id"])
        state = %{state | pending: pending, codex_thread_id: codex_id, ready: true}
        persist_binding(state)
        Enum.each(state.ready_waiters, &GenServer.reply(&1, :ok))
        %{state | ready_waiters: []}

      {%{from: nil, method: "thread/resume"}, pending} ->
        # Resume succeeded — same handling as thread/start
        codex_id = get_in(result, ["thread", "id"])
        state = %{state | pending: pending, codex_thread_id: codex_id, ready: true}
        persist_binding(state)
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

      {%{from: nil, method: "thread/resume"}, pending} ->
        # Resume failed — check if recoverable, fallback to thread/start
        message = Map.get(error, "message", "Unknown error")
        state = %{state | pending: pending}

        # Delete stale binding before any retry — prevents livelock if
        # the cursor is permanently invalid. This runs for both recoverable
        # and non-recoverable failures intentionally: if resume failed, the
        # cursor is suspect. The recoverable path falls back to thread/start
        # which upserts a fresh binding on success.
        Harness.Storage.delete_binding(state.thread_id)

        if is_recoverable_resume_error?(message) do
          Logger.info(
            "Thread resume failed (recoverable): #{message}, falling back to thread/start"
          )

          emit_event(state, :session, "session/threadResumeFallback", %{"error" => message})

          {new_id, state} = next_request_id(state)
          state = send_rpc_request(state, new_id, "thread/start", thread_overrides(state), nil)
          pending_entry = Map.get(state.pending, new_id)
          put_in(state.pending[new_id], %{pending_entry | method: "thread/start"})
        else
          Logger.error("Thread resume failed (non-recoverable): #{message}")
          Enum.each(state.ready_waiters, &GenServer.reply(&1, {:error, message}))
          %{state | ready_waiters: []}
        end

      {%{from: nil, method: "account/read"}, pending} ->
        # Account read failed — proceed with default account (spark enabled)
        Logger.warning("Account read failed: #{inspect(error)}, using defaults")

        state = %{
          state
          | pending: pending,
            account: %{type: "unknown", plan_type: nil, spark_enabled: true}
        }

        send(self(), :start_thread)
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
    request_id = Map.get(params, "requestId", "rpc-#{id}")
    runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

    is_user_input =
      method in ["ask_user", "user_input", "elicitation"] or
        (is_binary(method) and String.contains?(String.downcase(method), "ask_user"))

    # Auto-approve approval requests in full-access mode (Codex CLI sometimes
    # sends exec_approval_request even with approvalPolicy: "never", e.g. on
    # resumed sessions or model changes).
    is_approval = not is_user_input and runtime_mode == "full-access"

    if is_approval do
      # Codex CLI expects {"decision":"accept"} per official app-server protocol.
      # Valid variants: "accept", "acceptForSession", "decline", "cancel".
      Logger.info("Auto-approving Codex request #{method} (full-access mode)")
      response = JsonRpc.encode_response(id, %{"decision" => "accept"})
      send_to_port(state, response)

      # Intentional: auto-approved requests skip state.pending and have no
      # corresponding "request.opened" event. The resolve notification lets
      # the Node side log the decision without requiring a matching open.
      emit_event(state, :notification, "request/resolved", %{
        "requestId" => request_id,
        "decision" => "accept"
      })

      state
    else
      if is_user_input do
        questions = Map.get(params, "questions", [Map.get(params, "question", %{})])

        emit_event(state, :request, "user-input/requested", %{
          "requestId" => request_id,
          "rpcId" => id,
          "questions" => questions
        })
      else
        emit_event(state, :request, method, Map.put(params, "rpcId", id))
      end

      pending =
        Map.put(state.pending, id, %{
          kind: :provider_request,
          method: method,
          params: Map.put(params, "requestId", request_id),
          from: nil,
          timer: nil
        })

      %{state | pending: pending}
    end
  end

  defp handle_rpc_notification(state, method, params) do
    # Track collab receiver turns for child conversation suppression
    state = maybe_track_collab_receivers(state, method, params)

    # Check if this is a child conversation notification that should be suppressed
    unless should_suppress_notification?(state, method, params) do
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
    end

    state
  end

  # --- Collab Child Conversation Suppression ---

  defp maybe_track_collab_receivers(state, _method, params) do
    # When a collab agent tool call completes, track the receiver thread IDs
    item = get_in(params, ["item"]) || get_in(params, ["msg"]) || %{}
    item_type = Map.get(item, "type") || Map.get(item, "kind", "")

    if item_type == "collabAgentToolCall" do
      receiver_ids =
        Map.get(item, "receiverThreadIds", [])
        |> Enum.filter(&is_binary/1)

      parent_turn_id = Map.get(item, "turnId") || Map.get(params, "turnId")

      if parent_turn_id && length(receiver_ids) > 0 do
        new_receivers =
          Enum.reduce(receiver_ids, state.collab_receiver_turns, fn tid, acc ->
            Map.put(acc, tid, parent_turn_id)
          end)

        %{state | collab_receiver_turns: new_receivers}
      else
        state
      end
    else
      state
    end
  end

  defp should_suppress_notification?(state, method, params) do
    # Check if this notification came from a child conversation
    thread_id = get_in(params, ["threadId"]) || get_in(params, ["thread", "id"])

    if thread_id && Map.has_key?(state.collab_receiver_turns, thread_id) do
      MapSet.member?(@suppressed_child_methods, method)
    else
      false
    end
  end

  # --- Thread Resume Helpers ---

  defp is_recoverable_resume_error?(message) do
    lower = String.downcase(message)
    Enum.any?(@recoverable_resume_errors, &String.contains?(lower, &1))
  end

  # --- Thread Helpers ---

  defp thread_overrides(state) do
    runtime_mode = Map.get(state.params, "runtimeMode", "full-access")

    {approval_policy, sandbox} =
      case runtime_mode do
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

    pending =
      Map.put(state.pending, id, %{
        method: method,
        from: from,
        timer: timer
      })

    %{state | pending: pending}
  end

  defp send_to_port(%{port: nil}, _message) do
    {:error, :port_closed}
  end

  defp send_to_port(%{port: port}, message) do
    Port.command(port, message <> "\n")
  end

  defp persist_binding(state) do
    cursor_json =
      if state.codex_thread_id do
        Jason.encode!(%{"threadId" => state.codex_thread_id})
      end

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

  defp reject_all_pending(state, _reason) do
    Enum.each(state.pending, fn
      {_id, %{kind: :provider_request, params: params} = entry} ->
        # Emit cancellation event so pending request row is cleaned up
        request_id = Map.get(params, "requestId", "unknown")

        if Map.get(entry, :method) in ["ask_user", "user_input", "elicitation"] do
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

        # Reply to waiting caller if any
        if entry[:from], do: GenServer.reply(entry.from, {:error, "Session terminated"})
        if entry[:timer], do: Process.cancel_timer(entry.timer)

      {_id, %{from: from, timer: timer}} when not is_nil(from) ->
        if timer, do: Process.cancel_timer(timer)
        GenServer.reply(from, {:error, "Session terminated"})

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
