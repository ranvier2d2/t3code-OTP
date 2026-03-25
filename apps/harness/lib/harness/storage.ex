defmodule Harness.Storage do
  @moduledoc """
  SQLite durability layer for harness events and session state.

  Owns a single Exqlite connection with WAL mode enabled.
  All reads/writes are serialized through this GenServer.
  """
  use GenServer
  require Logger

  alias Exqlite.Sqlite3
  alias Harness.Snapshot

  @default_db_path "priv/data/harness.db"

  # --- Public API ---

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Insert an event into the append-only event log. Returns {:ok, global_sequence} or {:error, :duplicate_event}."
  def insert_event(event_map) do
    GenServer.call(__MODULE__, {:insert_event, event_map})
  end

  @doc "Upsert a session projection row."
  def upsert_session(session_map) do
    GenServer.call(__MODULE__, {:upsert_session, session_map})
  end

  @doc "Get all persisted sessions as Snapshot.Session structs."
  def get_all_sessions do
    GenServer.call(__MODULE__, :get_all_sessions)
  end

  @doc "Get the highest global_sequence, or 0 if empty."
  def get_max_sequence do
    GenServer.call(__MODULE__, :get_max_sequence)
  end

  @doc "Replay events after a given sequence number."
  def replay_since(after_seq, limit \\ 500) do
    GenServer.call(__MODULE__, {:replay_since, after_seq, limit})
  end

  @doc "Get total event count (for diagnostics)."
  def get_event_count do
    GenServer.call(__MODULE__, :get_event_count)
  end

  @doc "Truncate all tables. Test-only."
  def reset! do
    GenServer.call(__MODULE__, :reset)
  end

  # --- GenServer callbacks ---

  @impl true
  def init(opts) do
    db_path = resolve_db_path(opts)

    case open_and_migrate(db_path) do
      {:ok, conn} ->
        Logger.info("Storage opened at #{db_path}")
        {:ok, %{conn: conn, db_path: db_path}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_call({:insert_event, event_map}, _from, %{conn: conn} = state) do
    result = do_insert_event(conn, event_map)
    {:reply, result, state}
  end

  def handle_call({:upsert_session, session_map}, _from, %{conn: conn} = state) do
    result = do_upsert_session(conn, session_map)
    {:reply, result, state}
  end

  def handle_call(:get_all_sessions, _from, %{conn: conn} = state) do
    sessions = do_get_all_sessions(conn)
    {:reply, sessions, state}
  end

  def handle_call(:get_max_sequence, _from, %{conn: conn} = state) do
    seq = do_get_max_sequence(conn)
    {:reply, seq, state}
  end

  def handle_call({:replay_since, after_seq, limit}, _from, %{conn: conn} = state) do
    result = do_replay_since(conn, after_seq, limit)
    {:reply, result, state}
  end

  def handle_call(:get_event_count, _from, %{conn: conn} = state) do
    count = do_get_event_count(conn)
    {:reply, count, state}
  end

  def handle_call(:reset, _from, %{conn: conn} = state) do
    Sqlite3.execute(conn, "DELETE FROM harness_events")
    Sqlite3.execute(conn, "DELETE FROM harness_sessions")
    {:reply, :ok, state}
  end

  @impl true
  def terminate(_reason, %{conn: conn}) do
    Sqlite3.close(conn)
  end

  # --- DB initialization ---

  defp resolve_db_path(opts) do
    cond do
      opts[:db_path] ->
        opts[:db_path]

      config_path = get_in(Application.get_env(:harness, __MODULE__, []), [:db_path]) ->
        config_path

      true ->
        @default_db_path
    end
  end

  defp open_and_migrate(db_path) do
    if is_binary(db_path) and db_path != ":memory:" do
      db_path |> Path.dirname() |> File.mkdir_p!()
    end

    case Sqlite3.open(db_path) do
      {:ok, conn} ->
        Sqlite3.execute(conn, "PRAGMA journal_mode = WAL")
        Sqlite3.execute(conn, "PRAGMA synchronous = NORMAL")
        Sqlite3.execute(conn, "PRAGMA foreign_keys = ON")
        Sqlite3.execute(conn, "PRAGMA busy_timeout = 5000")
        run_migrations(conn)
        {:ok, conn}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_migrations(conn) do
    Sqlite3.execute(conn, """
    CREATE TABLE IF NOT EXISTS harness_events (
      global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )
    """)

    Sqlite3.execute(conn, """
    CREATE INDEX IF NOT EXISTS idx_events_thread
      ON harness_events(thread_id, global_sequence)
    """)

    Sqlite3.execute(conn, """
    CREATE TABLE IF NOT EXISTS harness_sessions (
      thread_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      cwd TEXT,
      runtime_mode TEXT,
      active_turn_json TEXT,
      pending_requests_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0
    )
    """)
  end

  # --- Event operations ---

  defp do_insert_event(conn, event_map) do
    sql = """
    INSERT INTO harness_events (event_id, thread_id, provider, kind, method, payload_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    """

    kind_str =
      if is_atom(event_map.kind), do: Atom.to_string(event_map.kind), else: event_map.kind

    payload_json = if event_map[:payload], do: Jason.encode!(event_map.payload), else: nil

    params = [
      event_map.event_id,
      event_map.thread_id,
      event_map.provider,
      kind_str,
      event_map.method,
      payload_json,
      event_map.created_at
    ]

    {:ok, stmt} = Sqlite3.prepare(conn, sql)

    try do
      :ok = Sqlite3.bind(stmt, params)

      case Sqlite3.step(conn, stmt) do
        :done ->
          {:ok, seq} = Sqlite3.last_insert_rowid(conn)
          {:ok, seq}

        {:error, reason} ->
          if is_binary(reason) and String.contains?(reason, "UNIQUE constraint failed") do
            {:error, :duplicate_event}
          else
            {:error, reason}
          end
      end
    rescue
      e in Exqlite.Error ->
        if String.contains?(to_string(e.message), "UNIQUE constraint failed") do
          {:error, :duplicate_event}
        else
          {:error, e.message}
        end
    after
      Sqlite3.release(conn, stmt)
    end
  end

  defp do_upsert_session(conn, session_map) do
    sql = """
    INSERT INTO harness_sessions
      (thread_id, provider, status, model, cwd, runtime_mode,
       active_turn_json, pending_requests_json, created_at, updated_at, last_sequence)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(thread_id) DO UPDATE SET
      provider = excluded.provider,
      status = excluded.status,
      model = excluded.model,
      cwd = excluded.cwd,
      runtime_mode = excluded.runtime_mode,
      active_turn_json = excluded.active_turn_json,
      pending_requests_json = excluded.pending_requests_json,
      updated_at = excluded.updated_at,
      last_sequence = excluded.last_sequence
    """

    status_str = serialize_atom(session_map.status)
    runtime_mode_str = serialize_runtime_mode(session_map[:runtime_mode])
    active_turn_json = encode_json(session_map[:active_turn])
    pending_requests_json = encode_json(session_map[:pending_requests])

    params = [
      session_map.thread_id,
      session_map.provider,
      status_str,
      session_map[:model],
      session_map[:cwd],
      runtime_mode_str,
      active_turn_json,
      pending_requests_json,
      session_map[:created_at],
      session_map[:updated_at],
      session_map[:last_sequence] || 0
    ]

    {:ok, stmt} = Sqlite3.prepare(conn, sql)

    try do
      :ok = Sqlite3.bind(stmt, params)
      :done = Sqlite3.step(conn, stmt)
      :ok
    after
      Sqlite3.release(conn, stmt)
    end
  end

  # --- Session queries ---

  defp do_get_all_sessions(conn) do
    sql = """
    SELECT thread_id, provider, status, model, cwd, runtime_mode,
           active_turn_json, pending_requests_json, created_at, updated_at, last_sequence
    FROM harness_sessions
    """

    query_all(conn, sql, [])
    |> Enum.map(&row_to_session/1)
  end

  defp do_get_max_sequence(conn) do
    case query_one(conn, "SELECT MAX(global_sequence) FROM harness_events", []) do
      [nil] -> 0
      [seq] -> seq
      nil -> 0
    end
  end

  defp do_get_event_count(conn) do
    case query_one(conn, "SELECT COUNT(*) FROM harness_events", []) do
      [count] -> count
      nil -> 0
    end
  end

  # --- Replay ---

  defp do_replay_since(conn, after_seq, limit) do
    sql = """
    SELECT global_sequence, event_id, thread_id, provider, kind, method, payload_json, created_at
    FROM harness_events
    WHERE global_sequence > ?1
    ORDER BY global_sequence ASC
    LIMIT ?2
    """

    events =
      query_all(conn, sql, [after_seq, limit])
      |> Enum.map(&row_to_event_map/1)

    {:ok, events}
  end

  # --- Query helpers ---

  defp query_all(conn, sql, params) do
    {:ok, stmt} = Sqlite3.prepare(conn, sql)

    try do
      :ok = Sqlite3.bind(stmt, params)
      fetch_rows(conn, stmt)
    after
      Sqlite3.release(conn, stmt)
    end
  end

  defp query_one(conn, sql, params) do
    {:ok, stmt} = Sqlite3.prepare(conn, sql)

    try do
      :ok = Sqlite3.bind(stmt, params)

      case Sqlite3.step(conn, stmt) do
        {:row, row} -> row
        :done -> nil
      end
    after
      Sqlite3.release(conn, stmt)
    end
  end

  defp fetch_rows(conn, stmt) do
    case Sqlite3.step(conn, stmt) do
      {:row, row} -> [row | fetch_rows(conn, stmt)]
      :done -> []
    end
  end

  # --- Row → struct conversions ---

  defp row_to_session([
         thread_id,
         provider,
         status,
         model,
         cwd,
         runtime_mode,
         active_turn_json,
         pending_requests_json,
         created_at,
         updated_at,
         _last_sequence
       ]) do
    %Snapshot.Session{
      thread_id: thread_id,
      provider: provider,
      status: parse_status(status),
      model: model,
      cwd: cwd,
      runtime_mode: parse_runtime_mode(runtime_mode),
      active_turn: decode_json(active_turn_json),
      pending_requests: decode_json(pending_requests_json) || %{},
      created_at: created_at,
      updated_at: updated_at
    }
  end

  defp row_to_event_map([
         seq,
         event_id,
         thread_id,
         provider,
         kind,
         method,
         payload_json,
         created_at
       ]) do
    %{
      seq: seq,
      eventId: event_id,
      threadId: thread_id,
      provider: provider,
      createdAt: created_at,
      kind: kind,
      method: method,
      payload: decode_json(payload_json)
    }
  end

  # --- Serialization helpers ---

  defp serialize_atom(nil), do: nil
  defp serialize_atom(atom) when is_atom(atom), do: Atom.to_string(atom)
  defp serialize_atom(str) when is_binary(str), do: str

  defp serialize_runtime_mode(:full_access), do: "full-access"
  defp serialize_runtime_mode(:approval_required), do: "approval-required"
  defp serialize_runtime_mode(nil), do: nil
  defp serialize_runtime_mode(other), do: to_string(other)

  defp parse_status("connecting"), do: :connecting
  defp parse_status("ready"), do: :ready
  defp parse_status("running"), do: :running
  defp parse_status("error"), do: :error
  defp parse_status("closed"), do: :closed
  defp parse_status(nil), do: :closed

  defp parse_runtime_mode("full-access"), do: :full_access
  defp parse_runtime_mode("full_access"), do: :full_access
  defp parse_runtime_mode("approval-required"), do: :approval_required
  defp parse_runtime_mode("approval_required"), do: :approval_required
  defp parse_runtime_mode(nil), do: nil
  defp parse_runtime_mode(_), do: nil

  defp encode_json(nil), do: nil
  defp encode_json(map) when map == %{}, do: nil
  defp encode_json(data), do: Jason.encode!(data)

  defp decode_json(nil), do: nil
  defp decode_json(""), do: nil
  defp decode_json(str) when is_binary(str), do: Jason.decode!(str)
end
