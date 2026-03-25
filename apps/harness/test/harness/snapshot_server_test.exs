defmodule Harness.SnapshotServerTest do
  use ExUnit.Case

  alias Harness.SnapshotServer
  alias Harness.Storage
  alias Harness.Event

  setup do
    # SnapshotServer is started by the application, but in tests
    # we need to ensure it's running. If it's already running, this is a no-op.
    case GenServer.whereis(SnapshotServer) do
      nil ->
        start_supervised!(SnapshotServer)

      _pid ->
        # Reset state for test isolation
        # We can't easily reset, so just proceed
        :ok
    end

    :ok
  end

  test "get_snapshot returns initial empty snapshot" do
    snapshot = SnapshotServer.get_snapshot()
    assert is_map(snapshot)
    assert snapshot.sequence >= 0
    assert is_map(snapshot.sessions)
  end

  test "apply_event updates snapshot" do
    initial = SnapshotServer.get_snapshot()
    initial_seq = initial.sequence

    event =
      Event.new(%{
        thread_id: "test-thread-#{System.unique_integer([:positive])}",
        provider: "codex",
        kind: :session,
        method: "session/connecting",
        payload: %{"model" => "gpt-4", "cwd" => "/tmp"}
      })

    SnapshotServer.apply_event(event)

    # Force mailbox flush — deterministic alternative to Process.sleep
    :sys.get_state(Harness.SnapshotServer)

    snapshot = SnapshotServer.get_snapshot()
    assert snapshot.sequence == initial_seq + 1
    assert Map.has_key?(snapshot.sessions, event.thread_id)

    session = snapshot.sessions[event.thread_id]
    assert session.provider == "codex"
    assert session.status == "connecting"
  end
end

defmodule Harness.SnapshotServer.ReconciliationTest do
  @moduledoc """
  Tests for recovery reconciliation — stale running/connecting sessions
  should be marked as error on SnapshotServer boot.
  """
  use ExUnit.Case

  alias Harness.SnapshotServer
  alias Harness.Storage

  defp make_session(thread_id, opts) do
    %{
      thread_id: thread_id,
      provider: Keyword.get(opts, :provider, "codex"),
      status: Keyword.get(opts, :status, :ready),
      model: Keyword.get(opts, :model, "gpt-5.3-codex"),
      cwd: Keyword.get(opts, :cwd, "/tmp"),
      runtime_mode: Keyword.get(opts, :runtime_mode, :full_access),
      active_turn: Keyword.get(opts, :active_turn, nil),
      pending_requests: Keyword.get(opts, :pending_requests, %{}),
      created_at: "2026-03-24T20:00:00Z",
      updated_at: "2026-03-24T20:01:00Z",
      last_sequence: Keyword.get(opts, :last_sequence, 1)
    }
  end

  setup do
    # Stop app-managed processes
    case Process.whereis(SnapshotServer) do
      nil -> :ok
      _pid -> Supervisor.terminate_child(Harness.Supervisor, SnapshotServer)
    end

    case Process.whereis(Storage) do
      nil -> :ok
      _pid -> Supervisor.terminate_child(Harness.Supervisor, Storage)
    end

    # Start fresh in-memory Storage
    {:ok, _} = Storage.start_link(db_path: ":memory:")

    on_exit(fn ->
      # Stop test-managed processes (may already be dead)
      for name <- [SnapshotServer, Storage] do
        case Process.whereis(name) do
          nil -> :ok
          pid -> catch_exit(GenServer.stop(pid))
        end
      end

      # Restart app-managed versions
      Supervisor.restart_child(Harness.Supervisor, Storage)
      Supervisor.restart_child(Harness.Supervisor, SnapshotServer)
    end)

    :ok
  end

  test "reconciles running sessions to error on boot" do
    # Seed SQL with a running session (simulates crash mid-turn)
    Storage.upsert_session(make_session("thread-running", status: :running, last_sequence: 5))
    Storage.insert_event(%{
      event_id: "e1", thread_id: "thread-running", provider: "codex",
      kind: "session", method: "session/connecting", created_at: "2026-03-24T20:00:00Z"
    })

    # Start SnapshotServer — triggers recovery + reconciliation
    {:ok, _} = SnapshotServer.start_link(nil)

    snapshot = SnapshotServer.get_snapshot()
    session = snapshot.sessions["thread-running"]

    assert session.status == "error"
    # Sequence should be bumped by the reconciliation event
    assert snapshot.sequence > 1
  end

  test "reconciles connecting sessions to error on boot" do
    Storage.upsert_session(make_session("thread-conn", status: :connecting, last_sequence: 3))
    Storage.insert_event(%{
      event_id: "e1", thread_id: "thread-conn", provider: "codex",
      kind: "session", method: "session/connecting", created_at: "2026-03-24T20:00:00Z"
    })

    {:ok, _} = SnapshotServer.start_link(nil)

    snapshot = SnapshotServer.get_snapshot()
    session = snapshot.sessions["thread-conn"]

    assert session.status == "error"
  end

  test "leaves ready/closed/error sessions untouched" do
    Storage.upsert_session(make_session("thread-ready", status: :ready, last_sequence: 1))
    Storage.upsert_session(make_session("thread-closed", status: :closed, last_sequence: 2))
    Storage.upsert_session(make_session("thread-error", status: :error, last_sequence: 3))

    {:ok, _} = SnapshotServer.start_link(nil)

    snapshot = SnapshotServer.get_snapshot()

    assert snapshot.sessions["thread-ready"].status == "ready"
    assert snapshot.sessions["thread-closed"].status == "closed"
    assert snapshot.sessions["thread-error"].status == "error"
    # No reconciliation events — sequence stays at 0 (no events in log)
    assert snapshot.sequence == 0
  end

  test "persists synthetic reconciliation events to SQL" do
    Storage.upsert_session(make_session("thread-stale", status: :running, last_sequence: 5))
    # Need at least one event so max_sequence > 0
    Storage.insert_event(%{
      event_id: "e1", thread_id: "thread-stale", provider: "codex",
      kind: "notification", method: "turn/started",
      payload: %{"turn" => %{"id" => "t1"}},
      created_at: "2026-03-24T20:00:00Z"
    })

    {:ok, _} = SnapshotServer.start_link(nil)

    # Check that the reconciliation event was persisted
    {:ok, events} = Storage.replay_since(1)
    reconciliation = Enum.find(events, fn e -> String.starts_with?(e.eventId, "reconcile-") end)

    assert reconciliation != nil
    assert reconciliation.method == "session/error"
    assert reconciliation.payload["reason"] == "runtime_restarted"
    assert reconciliation.payload["previousStatus"] == "running"
  end

  test "reconciles multiple stale sessions in one boot" do
    Storage.upsert_session(make_session("t1", status: :running, last_sequence: 1))
    Storage.upsert_session(make_session("t2", status: :connecting, last_sequence: 2))
    Storage.upsert_session(make_session("t3", status: :ready, last_sequence: 3))

    {:ok, _} = SnapshotServer.start_link(nil)

    snapshot = SnapshotServer.get_snapshot()

    assert snapshot.sessions["t1"].status == "error"
    assert snapshot.sessions["t2"].status == "error"
    assert snapshot.sessions["t3"].status == "ready"

    # Sequence bumped by 2 (one per stale session)
    assert snapshot.sequence == 2
  end

  test "clears active_turn on reconciled sessions" do
    active_turn = %{"turn_id" => "turn-99", "status" => "running"}
    Storage.upsert_session(
      make_session("thread-turn", status: :running, active_turn: active_turn, last_sequence: 5)
    )

    {:ok, _} = SnapshotServer.start_link(nil)

    snapshot = SnapshotServer.get_snapshot()
    session = snapshot.sessions["thread-turn"]

    assert session.status == "error"
    assert session.activeTurn == nil
  end
end
