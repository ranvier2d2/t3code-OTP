defmodule Harness.StorageTest do
  use ExUnit.Case

  alias Harness.Storage
  alias Harness.Snapshot
  alias Harness.SnapshotServer
  alias Harness.Event

  defp make_event(id, thread_id \\ "thread-1", opts \\ []) do
    %{
      event_id: id,
      thread_id: thread_id,
      provider: Keyword.get(opts, :provider, "codex"),
      kind: Keyword.get(opts, :kind, :notification),
      method: Keyword.get(opts, :method, "turn/started"),
      payload: Keyword.get(opts, :payload, %{"turn" => %{"id" => "turn-1"}}),
      created_at: Keyword.get(opts, :created_at, "2026-03-24T20:00:00Z")
    }
  end

  defp make_session(thread_id, opts \\ []) do
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
    # The Application supervisor starts Storage. We need to stop it
    # and restart with :memory: for isolated tests.
    case Process.whereis(Storage) do
      nil -> :ok
      _pid -> Supervisor.terminate_child(Harness.Supervisor, Storage)
    end

    # Also stop SnapshotServer since it depends on Storage
    case Process.whereis(SnapshotServer) do
      nil -> :ok
      _pid -> Supervisor.terminate_child(Harness.Supervisor, SnapshotServer)
    end

    # Start fresh in-memory Storage
    {:ok, _} = Storage.start_link(db_path: ":memory:")

    on_exit(fn ->
      # Restart the Application-managed versions
      case Process.whereis(Storage) do
        nil -> :ok
        pid -> GenServer.stop(pid)
      end

      Supervisor.restart_child(Harness.Supervisor, Storage)
      Supervisor.restart_child(Harness.Supervisor, SnapshotServer)
    end)

    :ok
  end

  # --- Event tests ---

  test "insert_event stores and returns global_sequence" do
    assert {:ok, 1} = Storage.insert_event(make_event("e1"))
    assert {:ok, 2} = Storage.insert_event(make_event("e2"))
  end

  test "insert_event with duplicate event_id returns error" do
    assert {:ok, 1} = Storage.insert_event(make_event("e1"))
    assert {:error, :duplicate_event} = Storage.insert_event(make_event("e1"))
  end

  test "get_event_count returns total count" do
    assert Storage.get_event_count() == 0
    Storage.insert_event(make_event("e1"))
    Storage.insert_event(make_event("e2"))
    Storage.insert_event(make_event("e3"))
    assert Storage.get_event_count() == 3
  end

  test "get_max_sequence returns 0 when empty" do
    assert Storage.get_max_sequence() == 0
  end

  test "get_max_sequence returns highest sequence" do
    Storage.insert_event(make_event("e1"))
    Storage.insert_event(make_event("e2"))
    Storage.insert_event(make_event("e3"))
    assert Storage.get_max_sequence() == 3
  end

  # --- Session tests ---

  test "upsert_session creates new session" do
    assert :ok = Storage.upsert_session(make_session("t1"))
    sessions = Storage.get_all_sessions()
    assert length(sessions) == 1
    assert hd(sessions).thread_id == "t1"
  end

  test "upsert_session updates existing session" do
    Storage.upsert_session(make_session("t1", status: :connecting))
    Storage.upsert_session(make_session("t1", status: :ready))
    sessions = Storage.get_all_sessions()
    assert length(sessions) == 1
    assert hd(sessions).status == :ready
  end

  test "get_all_sessions returns Snapshot.Session structs with proper atoms" do
    Storage.upsert_session(make_session("t1", status: :running, runtime_mode: :approval_required))
    [session] = Storage.get_all_sessions()
    assert %Snapshot.Session{} = session
    assert session.status == :running
    assert session.runtime_mode == :approval_required
    assert session.provider == "codex"
    assert session.model == "gpt-5.3-codex"
  end

  # --- Replay tests ---

  test "replay_since returns events after given sequence" do
    for i <- 1..5 do
      Storage.insert_event(make_event("e#{i}"))
    end

    assert {:ok, events} = Storage.replay_since(3)
    assert length(events) == 2
    assert Enum.map(events, & &1.seq) == [4, 5]
  end

  test "replay_since with limit truncates results" do
    for i <- 1..10 do
      Storage.insert_event(make_event("e#{i}"))
    end

    assert {:ok, events} = Storage.replay_since(0, 3)
    assert length(events) == 3
  end

  test "replay_since(0) returns all events" do
    for i <- 1..3 do
      Storage.insert_event(make_event("e#{i}"))
    end

    assert {:ok, events} = Storage.replay_since(0)
    assert length(events) == 3
    assert Enum.map(events, & &1.seq) == [1, 2, 3]
  end

  test "replay event map has correct camelCase keys" do
    Storage.insert_event(make_event("e1", "thread-1", method: "session/ready"))
    {:ok, [event]} = Storage.replay_since(0)
    assert event.eventId == "e1"
    assert event.threadId == "thread-1"
    assert event.method == "session/ready"
    assert event.kind == "notification"
    assert is_integer(event.seq)
  end

  # --- JSON roundtrip tests ---

  test "JSON roundtrip preserves payload structure" do
    payload = %{"nested" => %{"key" => [1, 2, 3]}, "flag" => true}
    Storage.insert_event(make_event("e1", "t1", payload: payload))
    {:ok, [event]} = Storage.replay_since(0)
    assert event.payload == payload
  end

  test "session active_turn and pending_requests survive JSON roundtrip" do
    active_turn = %{"id" => "turn-1", "started_at" => "2026-03-24T20:00:00Z"}

    pending = %{
      "req-1" => %{"type" => "approval", "tool" => "bash"},
      "req-2" => %{"type" => "user_input", "questions" => ["Continue?"]}
    }

    Storage.upsert_session(
      make_session("t1", active_turn: active_turn, pending_requests: pending)
    )

    [session] = Storage.get_all_sessions()
    assert session.active_turn == active_turn
    assert session.pending_requests == pending
  end

  # --- Integration: SnapshotServer recovery ---

  describe "SnapshotServer recovery" do
    setup do
      db_path =
        Path.join(
          System.tmp_dir!(),
          "harness_recovery_test_#{System.unique_integer([:positive])}.db"
        )

      # Stop the in-memory Storage from the parent setup
      case Process.whereis(Storage) do
        nil -> :ok
        pid -> GenServer.stop(pid)
      end

      # Start file-based Storage
      {:ok, _} = Storage.start_link(db_path: db_path)

      # Start SnapshotServer (will recover from the file-based Storage)
      {:ok, _} = SnapshotServer.start_link(nil)

      on_exit(fn ->
        case Process.whereis(SnapshotServer) do
          nil -> :ok
          pid -> GenServer.stop(pid)
        end

        case Process.whereis(Storage) do
          nil -> :ok
          pid -> GenServer.stop(pid)
        end

        File.rm(db_path)
        File.rm(db_path <> "-wal")
        File.rm(db_path <> "-shm")
      end)

      %{db_path: db_path}
    end

    test "recovers sessions after restart" do
      # Apply events through SnapshotServer
      SnapshotServer.apply_event(
        Event.new(%{
          thread_id: "t1",
          provider: "codex",
          kind: :session,
          method: "session/connecting",
          payload: %{"model" => "gpt-5.3-codex", "cwd" => "/tmp", "runtimeMode" => "full-access"}
        })
      )

      SnapshotServer.apply_event(
        Event.new(%{
          thread_id: "t1",
          provider: "codex",
          kind: :session,
          method: "session/ready",
          payload: %{}
        })
      )

      # Give cast time to process
      Process.sleep(50)

      # Verify snapshot before restart
      snapshot_before = SnapshotServer.get_snapshot()
      assert map_size(snapshot_before[:sessions]) == 1
      assert snapshot_before[:sessions]["t1"][:status] == "ready"

      # Kill and restart SnapshotServer (simulates BEAM restart for this process)
      GenServer.stop(SnapshotServer)
      {:ok, _} = SnapshotServer.start_link(nil)

      # Verify recovered snapshot
      snapshot_after = SnapshotServer.get_snapshot()
      assert map_size(snapshot_after[:sessions]) == 1
      assert snapshot_after[:sessions]["t1"][:status] == "ready"
      assert snapshot_after[:sequence] == 2
    end

    test "replay falls back to SQL after restart (WAL empty)" do
      # Apply events
      for i <- 1..3 do
        SnapshotServer.apply_event(
          Event.new(%{
            event_id: "evt-#{i}",
            thread_id: "t1",
            provider: "codex",
            kind: :notification,
            method: "turn/started",
            payload: %{"turn" => %{"id" => "turn-#{i}"}}
          })
        )
      end

      Process.sleep(50)

      # Restart — WAL is now empty
      GenServer.stop(SnapshotServer)
      {:ok, _} = SnapshotServer.start_link(nil)

      # Replay should fall back to SQL
      {:ok, seq, events} = SnapshotServer.replay_since(0)
      assert seq == 3
      assert length(events) == 3
    end
  end
end
