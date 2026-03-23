defmodule Harness.ProjectorTest do
  use ExUnit.Case

  alias Harness.Snapshot
  alias Harness.Projector
  alias Harness.Event

  test "projects session/connecting event into snapshot" do
    snapshot = %Snapshot{}

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :session,
      method: "session/connecting",
      payload: %{
        "model" => "gpt-4",
        "cwd" => "/tmp/test",
        "runtimeMode" => "approval-required"
      }
    })

    result = Projector.project(snapshot, event)

    assert result.sequence == 1
    assert Map.has_key?(result.sessions, "thread-1")

    session = result.sessions["thread-1"]
    assert session.thread_id == "thread-1"
    assert session.provider == "codex"
    assert session.status == :connecting
    assert session.model == "gpt-4"
    assert session.cwd == "/tmp/test"
    assert session.runtime_mode == :approval_required
  end

  test "projects session/ready event" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "codex",
          status: :connecting
        }
      }
    }

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :session,
      method: "session/ready",
      payload: %{}
    })

    result = Projector.project(snapshot, event)
    assert result.sessions["thread-1"].status == :ready
  end

  test "projects turn/started event" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "codex",
          status: :ready
        }
      }
    }

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :notification,
      method: "turn/started",
      payload: %{"turn" => %{"id" => "turn-abc"}}
    })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]
    assert session.status == :running
    assert session.active_turn.turn_id == "turn-abc"
  end

  test "projects turn/completed event" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "codex",
          status: :running,
          active_turn: %{turn_id: "turn-abc", status: :running}
        }
      }
    }

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :notification,
      method: "turn/completed",
      payload: %{}
    })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]
    assert session.status == :ready
    assert session.active_turn == nil
  end

  test "projects session/exited event" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "codex",
          status: :running
        }
      }
    }

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :session,
      method: "session/exited",
      payload: %{}
    })

    result = Projector.project(snapshot, event)
    assert result.sessions["thread-1"].status == :closed
  end

  test "sequence increments with each event" do
    snapshot = %Snapshot{}

    e1 = Event.new(%{thread_id: "t1", provider: "codex", kind: :session, method: "session/connecting", payload: %{}})
    e2 = Event.new(%{thread_id: "t1", provider: "codex", kind: :session, method: "session/ready", payload: %{}})
    e3 = Event.new(%{thread_id: "t1", provider: "codex", kind: :notification, method: "some/event", payload: %{}})

    result = snapshot |> Projector.project(e1) |> Projector.project(e2) |> Projector.project(e3)
    assert result.sequence == 3
  end

  test "unknown events pass through without mutation" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "codex",
          status: :ready
        }
      }
    }

    event = Event.new(%{
      thread_id: "thread-1",
      provider: "codex",
      kind: :notification,
      method: "item/agentMessage/delta",
      payload: %{"delta" => "hello"}
    })

    result = Projector.project(snapshot, event)
    # Sequence increments but session state unchanged
    assert result.sequence == 1
    assert result.sessions["thread-1"].status == :ready
  end
end
