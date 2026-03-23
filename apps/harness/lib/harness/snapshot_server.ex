defmodule Harness.SnapshotServer do
  @moduledoc """
  GenServer holding the current HarnessSnapshot.

  On each harness event:
  1. Assigns a monotonic sequence number
  2. Projects the event into the snapshot via Projector
  3. Appends to the WAL (write-ahead log) ring buffer for replay on reconnect
  4. Broadcasts the event via PubSub for Channel subscribers
  5. Serves snapshot queries and replay requests
  """
  use GenServer

  alias Harness.Snapshot
  alias Harness.Projector
  alias Harness.Event

  # Ring buffer size — last N events retained for reconnection replay
  @wal_max_size 500

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %Snapshot{}, name: __MODULE__)
  end

  @doc """
  Get the current snapshot.
  """
  def get_snapshot do
    GenServer.call(__MODULE__, :get_snapshot)
  end

  @doc """
  Apply a harness event to the snapshot and broadcast it.
  """
  def apply_event(%Event{} = event) do
    GenServer.cast(__MODULE__, {:apply_event, event})
  end

  @doc """
  Replay events since a given sequence number.
  Returns {current_seq, missed_events} where missed_events is a list of
  event maps with seq >= after_seq, ordered oldest-first.
  If after_seq is too old (evicted from the ring buffer), returns :gap.
  """
  def replay_since(after_seq) do
    GenServer.call(__MODULE__, {:replay_since, after_seq})
  end

  # --- Callbacks ---

  @impl true
  def init(snapshot) do
    {:ok, {snapshot, _wal = :queue.new(), _wal_size = 0, _seq = 0}}
  end

  @impl true
  def handle_call(:get_snapshot, _from, {snapshot, _wal, _wal_size, seq} = state) do
    reply = snapshot_to_map(snapshot) |> Map.put(:sequence, seq)
    {:reply, reply, state}
  end

  @impl true
  def handle_call({:replay_since, after_seq}, _from, {_snapshot, wal, wal_size, seq} = state) do
    if wal_size == 0 or after_seq >= seq do
      # Nothing to replay
      {:reply, {:ok, seq, []}, state}
    else
      # Check if the requested seq is still in the buffer
      wal_list = :queue.to_list(wal)
      oldest_seq = case List.first(wal_list) do
        {s, _} -> s
        _ -> seq
      end

      if after_seq < oldest_seq do
        # Gap — requested events have been evicted
        {:reply, {:gap, seq, oldest_seq}, state}
      else
        # Replay events with seq > after_seq
        missed = wal_list
          |> Enum.filter(fn {s, _} -> s > after_seq end)
          |> Enum.map(fn {s, event_map} -> Map.put(event_map, :seq, s) end)
        {:reply, {:ok, seq, missed}, state}
      end
    end
  end

  @impl true
  def handle_cast({:apply_event, event}, {snapshot, wal, wal_size, seq}) do
    new_seq = seq + 1
    new_snapshot = Projector.project(snapshot, event)

    event_map = event_to_map(event) |> Map.put(:seq, new_seq)

    # Append to WAL ring buffer
    {new_wal, new_wal_size} = wal_append(wal, wal_size, {new_seq, event_map})

    # Broadcast raw event with sequence number
    Phoenix.PubSub.broadcast(
      Harness.PubSub,
      "harness:events",
      {:harness_event, event_map}
    )

    # Broadcast session change if session state was modified
    if session_changed?(snapshot, new_snapshot, event.thread_id) do
      case Map.get(new_snapshot.sessions, event.thread_id) do
        nil ->
          :ok

        session ->
          Phoenix.PubSub.broadcast(
            Harness.PubSub,
            "harness:events",
            {:harness_session_changed, %{
              threadId: event.thread_id,
              session: session_to_map(session)
            }}
          )
      end
    end

    {:noreply, {new_snapshot, new_wal, new_wal_size, new_seq}}
  end

  # --- WAL Ring Buffer ---

  defp wal_append(wal, wal_size, entry) do
    new_wal = :queue.in(entry, wal)
    if wal_size >= @wal_max_size do
      {_, trimmed} = :queue.out(new_wal)
      {trimmed, wal_size}
    else
      {new_wal, wal_size + 1}
    end
  end

  # --- Serialization ---

  defp snapshot_to_map(%Snapshot{} = s) do
    %{
      sequence: s.sequence,
      updatedAt: s.updated_at,
      sessions: Map.new(s.sessions, fn {k, v} -> {k, session_to_map(v)} end)
    }
  end

  defp session_to_map(%Snapshot.Session{} = s) do
    %{
      threadId: s.thread_id,
      provider: s.provider,
      status: Atom.to_string(s.status),
      model: s.model,
      cwd: s.cwd,
      runtimeMode: runtime_mode_to_string(s.runtime_mode),
      activeTurn: s.active_turn,
      pendingRequests: s.pending_requests,
      createdAt: s.created_at,
      updatedAt: s.updated_at
    }
  end

  defp event_to_map(%Event{} = e) do
    %{
      eventId: e.event_id,
      threadId: e.thread_id,
      provider: e.provider,
      createdAt: e.created_at,
      kind: Atom.to_string(e.kind),
      method: e.method,
      payload: e.payload
    }
  end

  defp session_changed?(old_snapshot, new_snapshot, thread_id) do
    Map.get(old_snapshot.sessions, thread_id) != Map.get(new_snapshot.sessions, thread_id)
  end

  defp runtime_mode_to_string(:full_access), do: "full-access"
  defp runtime_mode_to_string(:approval_required), do: "approval-required"
  defp runtime_mode_to_string(other), do: to_string(other)
end
