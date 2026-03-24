defmodule Harness.Projector do
  @moduledoc """
  Pure function: project(snapshot, event) → new_snapshot.

  Applies harness events to the in-memory snapshot.
  Same pattern as the existing projector.ts in the Node codebase.
  """

  alias Harness.Snapshot
  alias Harness.Snapshot.Session
  alias Harness.Event

  @doc """
  Project a harness event onto the snapshot, returning the updated snapshot.
  """
  @spec project(Snapshot.t(), Event.t()) :: Snapshot.t()
  def project(%Snapshot{} = snapshot, %Event{} = event) do
    snapshot
    |> increment_sequence()
    |> apply_event(event)
    |> update_timestamp(event.created_at)
  end

  defp increment_sequence(%Snapshot{sequence: seq} = snapshot) do
    %{snapshot | sequence: seq + 1}
  end

  defp update_timestamp(%Snapshot{} = snapshot, created_at) do
    %{snapshot | updated_at: created_at}
  end

  # --- Session lifecycle events ---

  defp apply_event(snapshot, %Event{kind: :session, method: "session/connecting"} = event) do
    session = %Session{
      thread_id: event.thread_id,
      provider: event.provider,
      status: :connecting,
      model: get_in(event.payload, ["model"]),
      cwd: get_in(event.payload, ["cwd"]),
      runtime_mode: parse_runtime_mode(get_in(event.payload, ["runtimeMode"])),
      created_at: event.created_at,
      updated_at: event.created_at
    }

    put_in(snapshot.sessions[event.thread_id], session)
  end

  defp apply_event(snapshot, %Event{kind: :session, method: "session/ready"} = event) do
    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :ready, updated_at: event.created_at}
    end)
  end

  defp apply_event(snapshot, %Event{kind: :session, method: "session/started"} = event) do
    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :ready, updated_at: event.created_at}
    end)
  end

  defp apply_event(snapshot, %Event{kind: :session, method: method} = event)
       when method in ["session/exited", "session/closed"] do
    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :closed, active_turn: nil, updated_at: event.created_at}
    end)
  end

  defp apply_event(snapshot, %Event{kind: :session, method: "session/error"} = event) do
    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :error, active_turn: nil, updated_at: event.created_at}
    end)
  end

  # --- Turn events ---

  defp apply_event(snapshot, %Event{method: "turn/started"} = event) do
    turn = %{
      turn_id: get_in(event.payload, ["turn", "id"]),
      status: :running
    }

    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :running, active_turn: turn, updated_at: event.created_at}
    end)
  end

  defp apply_event(snapshot, %Event{method: "turn/completed"} = event) do
    update_session(snapshot, event.thread_id, fn session ->
      %{session | status: :ready, active_turn: nil, updated_at: event.created_at}
    end)
  end

  # --- Approval request events ---

  defp apply_event(snapshot, %Event{kind: :request} = event) do
    request_id = get_in(event.payload, ["requestId"]) || event.event_id

    update_session(snapshot, event.thread_id, fn session ->
      pending =
        Map.put(session.pending_requests, request_id, %{
          method: event.method,
          payload: event.payload,
          created_at: event.created_at
        })

      %{session | pending_requests: pending, updated_at: event.created_at}
    end)
  end

  # --- Notification events that resolve pending requests ---

  defp apply_event(snapshot, %Event{kind: :notification, method: "request/resolved"} = event) do
    request_id = get_in(event.payload, ["requestId"]) || event.event_id

    update_session(snapshot, event.thread_id, fn session ->
      %{
        session
        | pending_requests: Map.delete(session.pending_requests, request_id),
          updated_at: event.created_at
      }
    end)
  end

  # --- Default: pass through without snapshot mutation ---

  defp apply_event(snapshot, _event) do
    snapshot
  end

  # --- Helpers ---

  defp update_session(snapshot, thread_id, update_fn) do
    case Map.get(snapshot.sessions, thread_id) do
      nil ->
        snapshot

      session ->
        updated = update_fn.(session)
        put_in(snapshot.sessions[thread_id], updated)
    end
  end

  defp parse_runtime_mode("full-access"), do: :full_access
  defp parse_runtime_mode("full_access"), do: :full_access
  defp parse_runtime_mode(_), do: :approval_required
end
