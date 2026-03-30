defmodule Harness.SessionManager do
  @moduledoc """
  Manages provider session lifecycle via DynamicSupervisor and Registry.

  Routes commands to the appropriate session GenServer based on threadId.
  Creates new sessions via DynamicSupervisor.start_child.
  """

  alias Harness.SnapshotServer
  alias Harness.Event

  require Logger
  alias Harness.Providers.CodexSession
  alias Harness.Providers.ClaudeSession
  alias Harness.Providers.OpenCodeSession
  alias Harness.Providers.CursorSession
  alias Harness.Providers.AcpSession

  @doc """
  Start a new provider session.
  """
  def start_session(params) do
    case Map.get(params, "threadId") do
      nil ->
        {:error, "Missing required param: threadId"}

      thread_id ->
        provider = Map.get(params, "provider", "codex")

        case provider_module(provider) do
          {:error, reason} ->
            {:error, reason}

          {:ok, session_module} ->
            start_session_with_module(session_module, thread_id, provider, params)
        end
    end
  end

  defp start_session_with_module(session_module, thread_id, provider, params) do
    params = maybe_inject_resume_cursor(params, thread_id, provider)

    child_spec =
      {session_module,
       %{
         thread_id: thread_id,
         provider: provider,
         params: params,
         event_callback: &handle_provider_event/1
       }}

    case DynamicSupervisor.start_child(Harness.SessionSupervisor, child_spec) do
      {:ok, pid} ->
        # Emit connecting only for genuinely new sessions
        SnapshotServer.apply_event(
          Event.new(%{
            thread_id: thread_id,
            provider: provider,
            kind: :session,
            method: "session/connecting",
            payload: params
          })
        )

        # Block until the GenServer reaches ready state (or timeout after 60s).
        # OpenCode's server takes ~20s to start; 30s was too tight.
        try do
          case session_module.wait_for_ready(pid, 60_000) do
            :ok ->
              {:ok,
               %{
                 threadId: thread_id,
                 provider: provider,
                 status: "ready"
               }}

            {:error, reason} ->
              SnapshotServer.apply_event(
                Event.new(%{
                  thread_id: thread_id,
                  provider: provider,
                  kind: :session,
                  method: "session/error",
                  payload: %{"error" => "Session failed to become ready: #{inspect(reason)}"}
                })
              )

              {:error, "Session failed to become ready: #{inspect(reason)}"}
          end
        catch
          :exit, reason ->
            SnapshotServer.apply_event(
              Event.new(%{
                thread_id: thread_id,
                provider: provider,
                kind: :session,
                method: "session/error",
                payload: %{"error" => "Session process died during init: #{inspect(reason)}"}
              })
            )

            {:error, "Session process died during init: #{inspect(reason)}"}
        end

      {:error, {:already_started, pid}} ->
        # Session already exists for this thread — reuse it.
        # Look up the actual running provider from Registry (may differ from the incoming request).
        actual_provider =
          case Registry.lookup(Harness.SessionRegistry, thread_id) do
            [{^pid, registered_provider}] -> registered_provider
            _ -> provider
          end

        Logger.info("Session already running for thread #{thread_id} (#{inspect(pid)}), reusing")

        {:ok,
         %{
           threadId: thread_id,
           provider: actual_provider,
           status: "ready"
         }}

      {:error, reason} ->
        SnapshotServer.apply_event(
          Event.new(%{
            thread_id: thread_id,
            provider: provider,
            kind: :session,
            method: "session/error",
            payload: %{"error" => inspect(reason)}
          })
        )

        {:error, "Failed to start session: #{inspect(reason)}"}
    end
  end

  @doc """
  Send a turn to an active session.
  """
  def send_turn(thread_id, params) do
    with_session(thread_id, fn pid, module ->
      module.send_turn(pid, params)
    end)
  end

  @doc """
  Interrupt an active turn.
  """
  def interrupt_turn(thread_id, turn_id) do
    with_session(thread_id, fn pid, module ->
      module.interrupt_turn(pid, thread_id, turn_id)
    end)
  end

  @doc """
  Respond to an approval request.
  """
  def respond_to_approval(thread_id, request_id, decision) do
    with_session(thread_id, fn pid, module ->
      module.respond_to_approval(pid, request_id, decision)
    end)
  end

  @doc """
  Respond to a user input request.
  """
  def respond_to_user_input(thread_id, request_id, answers) do
    with_session(thread_id, fn pid, module ->
      module.respond_to_user_input(pid, request_id, answers)
    end)
  end

  @doc """
  Stop a session.
  """
  def stop_session(thread_id) do
    case Registry.lookup(Harness.SessionRegistry, thread_id) do
      [{pid, _module}] ->
        DynamicSupervisor.terminate_child(Harness.SessionSupervisor, pid)
        :ok

      [] ->
        {:error, "Session not found: #{thread_id}"}
    end
  end

  @doc """
  Read thread state from provider.
  """
  def read_thread(thread_id) do
    with_session(thread_id, fn pid, module ->
      module.read_thread(pid, thread_id)
    end)
  end

  @doc """
  Rollback thread by N turns.
  """
  def rollback_thread(thread_id, num_turns) do
    with_session(thread_id, fn pid, module ->
      module.rollback_thread(pid, thread_id, num_turns)
    end)
  end

  @doc """
  List all active sessions.
  """
  def list_sessions do
    Registry.select(Harness.SessionRegistry, [{{:"$1", :"$2", :"$3"}, [], [{{:"$1", :"$3"}}]}])
    |> Enum.map(fn {thread_id, provider} ->
      %{threadId: thread_id, provider: provider}
    end)
  end

  # --- MCP Management (OpenCode only) ---

  @doc """
  Get MCP server status from an active OpenCode session.
  """
  def mcp_status(thread_id) do
    with_opencode_session(thread_id, fn pid ->
      GenServer.call(pid, :mcp_status, 15_000)
    end)
  end

  @doc """
  Add an MCP server configuration to an active OpenCode session.
  """
  def mcp_add(thread_id, name, config) do
    with_opencode_session(thread_id, fn pid ->
      GenServer.call(pid, {:mcp_add, name, config}, 15_000)
    end)
  end

  @doc """
  Connect an MCP server in an active OpenCode session.
  """
  def mcp_connect(thread_id, name) do
    with_opencode_session(thread_id, fn pid ->
      GenServer.call(pid, {:mcp_connect, name}, 15_000)
    end)
  end

  @doc """
  Disconnect an MCP server in an active OpenCode session.
  """
  def mcp_disconnect(thread_id, name) do
    with_opencode_session(thread_id, fn pid ->
      GenServer.call(pid, {:mcp_disconnect, name}, 15_000)
    end)
  end

  @doc """
  Query models from an active OpenCode session via HTTP (GET /provider).
  Falls back to {:error, reason} if no session is running or the call fails.
  """
  def list_models_from_session(thread_id) do
    with_opencode_session(thread_id, fn pid ->
      GenServer.call(pid, :list_models, 15_000)
    end)
    |> case do
      {:error, {:provider_mismatch, other}} ->
        {:error, "list_models_from_session only supports opencode, got: #{other}"}

      other ->
        other
    end
  end

  @doc """
  Get diagnostics from a session's GenServer state.
  Returns a safe subset of internal state for debugging.
  """
  def get_diagnostics(thread_id) do
    case Registry.lookup(Harness.SessionRegistry, thread_id) do
      [{pid, _provider}] ->
        try do
          GenServer.call(pid, :get_diagnostics, 5_000)
        catch
          :exit, reason -> {:error, "GenServer call failed: #{inspect(reason)}"}
        end

      [] ->
        {:error, "Session not found: #{thread_id}"}
    end
  end

  @doc """
  Stop all sessions.
  """
  def stop_all do
    DynamicSupervisor.which_children(Harness.SessionSupervisor)
    |> Enum.each(fn {_, pid, _, _} ->
      DynamicSupervisor.terminate_child(Harness.SessionSupervisor, pid)
    end)
  end

  # --- Internal ---

  defp with_session(thread_id, fun) do
    case Registry.lookup(Harness.SessionRegistry, thread_id) do
      [{pid, provider_string}] ->
        case provider_module(provider_string) do
          {:ok, module} -> fun.(pid, module)
          {:error, reason} -> {:error, reason}
        end

      [] ->
        {:error, "Session not found: #{thread_id}"}
    end
  end

  defp with_opencode_session(thread_id, fun) do
    case Registry.lookup(Harness.SessionRegistry, thread_id) do
      [{pid, "opencode"}] ->
        try do
          fun.(pid)
        catch
          :exit, reason -> {:error, "GenServer call failed: #{inspect(reason)}"}
        end

      [{_pid, other}] ->
        {:error, {:provider_mismatch, other}}

      [] ->
        {:error, "Session not found: #{thread_id}"}
    end
  end

  @doc false
  def handle_provider_event(event) do
    SnapshotServer.apply_event(event)
  end

  @doc false
  # Inject resumeCursor from SQLite binding if one exists and the provider matches.
  # If the caller already supplied a resumeCursor, respect it (don't overwrite).
  def maybe_inject_resume_cursor(%{"resumeCursor" => _} = params, _thread_id, _provider) do
    params
  end

  def maybe_inject_resume_cursor(params, thread_id, provider) do
    case Harness.Storage.get_binding(thread_id) do
      %{provider: ^provider, resume_cursor_json: cursor_json} when is_binary(cursor_json) ->
        case Jason.decode(cursor_json) do
          {:ok, cursor} ->
            normalized = normalize_resume_cursor(cursor)
            Logger.info("Injecting resumeCursor from binding for #{thread_id} (#{provider})")
            Map.put(params, "resumeCursor", normalized)

          {:error, reason} ->
            Logger.warning("Failed to decode binding cursor for #{thread_id}: #{inspect(reason)}")
            params
        end

      _ ->
        # No binding, provider mismatch, or nil cursor — start fresh
        params
    end
  end

  # Codex stores {"threadId": "..."} — CodexSession expects the raw string.
  # Cursor/OpenCode store richer objects — their session modules expect a JSON string
  # to decode themselves, so re-encode the decoded map back to JSON.
  defp normalize_resume_cursor(%{"cursorChatId" => _} = cursor), do: Jason.encode!(cursor)
  defp normalize_resume_cursor(%{"sessionId" => _} = cursor), do: Jason.encode!(cursor)
  defp normalize_resume_cursor(%{"threadId" => tid}) when is_binary(tid), do: tid
  defp normalize_resume_cursor(cursor), do: cursor

  defp provider_module("codex"), do: {:ok, CodexSession}
  defp provider_module("claudeAgent"), do: {:ok, ClaudeSession}
  defp provider_module("opencode"), do: {:ok, OpenCodeSession}

  defp provider_module("cursor") do
    if Application.get_env(:harness, :cursor_acp_enabled, false) do
      {:ok, AcpSession}
    else
      {:ok, CursorSession}
    end
  end

  defp provider_module("mock"), do: {:ok, Harness.Providers.MockSession}
  defp provider_module(other), do: {:error, "Unsupported provider: #{other}"}
end
