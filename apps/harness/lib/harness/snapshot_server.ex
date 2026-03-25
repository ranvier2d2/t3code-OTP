defmodule Harness.SnapshotServer do
  @moduledoc """
  GenServer holding the current HarnessSnapshot.

  On each harness event:
  1. Assigns a monotonic sequence number
  2. Projects the event into the snapshot via Projector
  3. Persists event + session to SQLite (best-effort)
  4. Appends to the WAL (write-ahead log) ring buffer for fast replay
  5. Broadcasts the event via PubSub for Channel subscribers
  6. Serves snapshot queries and replay requests

  On startup, recovers session state and sequence counter from SQLite.
  """
  use GenServer
  require Logger

  alias Harness.Snapshot
  alias Harness.Projector
  alias Harness.Event

  # Ring buffer size — last N events retained as hot cache for fast replay
  @wal_max_size 500

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
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
  Get WAL (write-ahead log) stats for developer diagnostics.
  Returns size, max_size, current sequence, and oldest retained sequence.
  """
  def get_wal_stats do
    GenServer.call(__MODULE__, :get_wal_stats)
  end

  @doc """
  Replay events since a given sequence number.
  Returns {current_seq, missed_events} where missed_events is a list of
  event maps with seq >= after_seq, ordered oldest-first.
  Falls back to SQLite when the ring buffer cannot serve the request.
  """
  def replay_since(after_seq) do
    GenServer.call(__MODULE__, {:replay_since, after_seq})
  end

  # --- Callbacks ---

  @impl true
  def init(_) do
    case recover_from_storage() do
      {:ok, snapshot, seq} ->
        Logger.info(
          "SnapshotServer recovered #{map_size(snapshot.sessions)} sessions, seq=#{seq}"
        )

        {:ok, {snapshot, _wal = :queue.new(), _wal_size = 0, seq}}

      {:error, reason} ->
        Logger.warning("SnapshotServer recovery failed: #{inspect(reason)}, starting fresh")
        {:ok, {%Snapshot{}, _wal = :queue.new(), _wal_size = 0, _seq = 0}}
    end
  end

  @impl true
  def handle_call(:get_snapshot, _from, {snapshot, _wal, _wal_size, seq} = state) do
    reply = snapshot_to_map(snapshot) |> Map.put(:sequence, seq)
    {:reply, reply, state}
  end

  @impl true
  def handle_call(:get_wal_stats, _from, {_snapshot, wal, wal_size, seq} = state) do
    oldest_seq =
      case :queue.peek(wal) do
        {:value, {s, _}} -> s
        :empty -> nil
      end

    {:reply, %{size: wal_size, max_size: @wal_max_size, sequence: seq, oldest_seq: oldest_seq},
     state}
  end

  @impl true
  def handle_call({:replay_since, after_seq}, _from, {_snapshot, wal, wal_size, seq} = state) do
    if wal_size == 0 or after_seq >= seq do
      # Nothing to replay from WAL — try SQL
      replay_from_sql_or_empty(after_seq, seq, state)
    else
      wal_list = :queue.to_list(wal)

      oldest_seq =
        case List.first(wal_list) do
          {s, _} -> s
          _ -> seq
        end

      if after_seq >= oldest_seq - 1 do
        # Serve from hot cache (WAL ring buffer)
        missed =
          wal_list
          |> Enum.filter(fn {s, _} -> s > after_seq end)
          |> Enum.map(fn {s, event_map} -> Map.put(event_map, :seq, s) end)

        {:reply, {:ok, seq, missed}, state}
      else
        # WAL too small — fall back to SQL
        replay_from_sql_or_empty(after_seq, seq, state)
      end
    end
  end

  @impl true
  def handle_cast({:apply_event, event}, {snapshot, wal, wal_size, seq}) do
    new_seq = seq + 1
    new_snapshot = Projector.project(snapshot, event)

    event_map = event_to_map(event) |> Map.put(:seq, new_seq)

    # Persist to SQLite (best-effort — broadcast even if SQL fails)
    persist(event, new_snapshot, new_seq)

    # Append to WAL ring buffer (hot cache for fast replay)
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
            {:harness_session_changed,
             %{
               threadId: event.thread_id,
               session: session_to_map(session)
             }}
          )
      end
    end

    {:noreply, {new_snapshot, new_wal, new_wal_size, new_seq}}
  end

  # --- Recovery ---

  defp recover_from_storage do
    sessions = Harness.Storage.get_all_sessions()
    seq = Harness.Storage.get_max_sequence()

    sessions_map = Map.new(sessions, fn session -> {session.thread_id, session} end)

    # Set sequence from SQL, NOT from Projector (avoids double-count)
    snapshot = %Snapshot{
      sequence: seq,
      updated_at: latest_updated_at(sessions),
      sessions: sessions_map
    }

    {:ok, snapshot, seq}
  rescue
    e -> {:error, e}
  catch
    :exit, reason -> {:error, reason}
  end

  defp latest_updated_at([]), do: nil

  defp latest_updated_at(sessions) do
    sessions
    |> Enum.map(& &1.updated_at)
    |> Enum.reject(&is_nil/1)
    |> Enum.max(fn -> nil end)
  end

  # --- Persistence ---

  defp persist(event, new_snapshot, new_seq) do
    try do
      case Harness.Storage.insert_event(%{
             event_id: event.event_id,
             thread_id: event.thread_id,
             provider: event.provider,
             kind: event.kind,
             method: event.method,
             payload: event.payload,
             created_at: event.created_at
           }) do
        {:ok, _seq} ->
          # Upsert session if it exists in the snapshot
          case Map.get(new_snapshot.sessions, event.thread_id) do
            nil ->
              :ok

            session ->
              Harness.Storage.upsert_session(%{
                thread_id: session.thread_id,
                provider: session.provider,
                status: session.status,
                model: session.model,
                cwd: session.cwd,
                runtime_mode: session.runtime_mode,
                active_turn: session.active_turn,
                pending_requests: session.pending_requests,
                created_at: session.created_at,
                updated_at: session.updated_at,
                last_sequence: new_seq
              })
          end

        {:error, :duplicate_event} ->
          :ok

        {:error, reason} ->
          Logger.error("Storage insert_event failed: #{inspect(reason)}")
      end
    catch
      :exit, reason ->
        Logger.error("Storage unavailable: #{inspect(reason)}")
    end
  end

  # --- SQL replay fallback ---

  defp replay_from_sql_or_empty(after_seq, seq, state) do
    try do
      case Harness.Storage.replay_since(after_seq) do
        {:ok, events} ->
          {:reply, {:ok, seq, events}, state}

        {:error, _reason} ->
          {:reply, {:ok, seq, []}, state}
      end
    catch
      :exit, _ ->
        {:reply, {:ok, seq, []}, state}
    end
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
