defmodule Harness.SnapshotServerTest do
  use ExUnit.Case

  alias Harness.SnapshotServer
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
