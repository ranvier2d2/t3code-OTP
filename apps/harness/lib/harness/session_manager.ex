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

  @doc """
  Start a new provider session.
  """
  def start_session(params) do
    thread_id = Map.fetch!(params, "threadId")
    provider = Map.get(params, "provider", "codex")

    case provider_module(provider) do
      {:error, reason} ->
        {:error, reason}

      {:ok, session_module} ->
        # Emit connecting event only after validating provider
        SnapshotServer.apply_event(Event.new(%{
          thread_id: thread_id,
          provider: provider,
          kind: :session,
          method: "session/connecting",
          payload: params
        }))

        start_session_with_module(session_module, thread_id, provider, params)
    end
  end

  defp start_session_with_module(session_module, thread_id, provider, params) do
    child_spec = {session_module, %{
      thread_id: thread_id,
      provider: provider,
      params: params,
      event_callback: &handle_provider_event/1
    }}

    case DynamicSupervisor.start_child(Harness.SessionSupervisor, child_spec) do
      {:ok, pid} ->
        # Block until the GenServer reaches ready state (or timeout after 60s).
        # OpenCode's server takes ~20s to start; 30s was too tight.
        try do
          case session_module.wait_for_ready(pid, 60_000) do
            :ok ->
              {:ok, %{
                threadId: thread_id,
                provider: provider,
                status: "ready"
              }}

            {:error, reason} ->
              SnapshotServer.apply_event(Event.new(%{
                thread_id: thread_id,
                provider: provider,
                kind: :session,
                method: "session/error",
                payload: %{"error" => "Session failed to become ready: #{inspect(reason)}"}
              }))

              {:error, "Session failed to become ready: #{inspect(reason)}"}
          end
        catch
          :exit, reason ->
            SnapshotServer.apply_event(Event.new(%{
              thread_id: thread_id,
              provider: provider,
              kind: :session,
              method: "session/error",
              payload: %{"error" => "Session process died during init: #{inspect(reason)}"}
            }))

            {:error, "Session process died during init: #{inspect(reason)}"}
        end

      {:error, {:already_started, pid}} ->
        # Session already exists for this thread — reuse it
        Logger.info("Session already running for thread #{thread_id} (#{inspect(pid)}), reusing")
        {:ok, %{
          threadId: thread_id,
          provider: provider,
          status: "ready"
        }}

      {:error, reason} ->
        SnapshotServer.apply_event(Event.new(%{
          thread_id: thread_id,
          provider: provider,
          kind: :session,
          method: "session/error",
          payload: %{"error" => inspect(reason)}
        }))

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

  @doc false
  def handle_provider_event(event) do
    SnapshotServer.apply_event(event)
  end

  defp provider_module("codex"), do: {:ok, CodexSession}
  defp provider_module("claudeAgent"), do: {:ok, ClaudeSession}
  defp provider_module("opencode"), do: {:ok, OpenCodeSession}
  defp provider_module("cursor"), do: {:ok, CursorSession}
  defp provider_module("mock"), do: {:ok, Harness.Providers.MockSession}
  defp provider_module(other), do: {:error, "Unsupported provider: #{other}"}
end
