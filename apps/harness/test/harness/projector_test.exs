defmodule Harness.ProjectorTest do
  use ExUnit.Case

  alias Harness.Snapshot
  alias Harness.Projector
  alias Harness.Event

  test "projects session/connecting event into snapshot" do
    snapshot = %Snapshot{}

    event =
      Event.new(%{
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

    event =
      Event.new(%{
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

    event =
      Event.new(%{
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

    event =
      Event.new(%{
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

    event =
      Event.new(%{
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

    e1 =
      Event.new(%{
        thread_id: "t1",
        provider: "codex",
        kind: :session,
        method: "session/connecting",
        payload: %{}
      })

    e2 =
      Event.new(%{
        thread_id: "t1",
        provider: "codex",
        kind: :session,
        method: "session/ready",
        payload: %{}
      })

    e3 =
      Event.new(%{
        thread_id: "t1",
        provider: "codex",
        kind: :notification,
        method: "some/event",
        payload: %{}
      })

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

    event =
      Event.new(%{
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

  # --- Approval request lifecycle ---

  test "request event adds entry to session pending_requests" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :running
        }
      }
    }

    event =
      Event.new(%{
        event_id: "req-001",
        thread_id: "thread-1",
        provider: "opencode",
        kind: :request,
        method: "request/opened",
        payload: %{
          "requestId" => "req-001",
          "requestType" => "command_execution_approval",
          "detail" => "ls /tmp"
        }
      })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]

    # Status unchanged — still running while waiting for approval
    assert session.status == :running
    # Pending request was recorded
    assert Map.has_key?(session.pending_requests, "req-001")
    req = session.pending_requests["req-001"]
    assert req.method == "request/opened"
    assert req.payload["requestType"] == "command_execution_approval"
  end

  test "request/resolved removes the entry from pending_requests" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :running,
          pending_requests: %{
            "req-001" => %{
              method: "request/opened",
              payload: %{"requestType" => "command_execution_approval"},
              created_at: "2026-01-01T00:00:00Z"
            }
          }
        }
      }
    }

    event =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :notification,
        method: "request/resolved",
        payload: %{
          "requestId" => "req-001",
          "decision" => "accept"
        }
      })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]

    refute Map.has_key?(session.pending_requests, "req-001")
  end

  test "request/resolved for unknown requestId is a no-op" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :running,
          pending_requests: %{
            "req-existing" => %{
              method: "request/opened",
              payload: %{},
              created_at: "2026-01-01T00:00:00Z"
            }
          }
        }
      }
    }

    event =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :notification,
        method: "request/resolved",
        payload: %{"requestId" => "req-nonexistent"}
      })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]

    # Existing request must still be present
    assert Map.has_key?(session.pending_requests, "req-existing")
    assert map_size(session.pending_requests) == 1
  end

  test "multiple concurrent pending requests are tracked independently" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :running
        }
      }
    }

    e1 =
      Event.new(%{
        event_id: "req-A",
        thread_id: "thread-1",
        provider: "opencode",
        kind: :request,
        method: "request/opened",
        payload: %{"requestId" => "req-A", "requestType" => "file_change_approval"}
      })

    e2 =
      Event.new(%{
        event_id: "req-B",
        thread_id: "thread-1",
        provider: "opencode",
        kind: :request,
        method: "request/opened",
        payload: %{"requestId" => "req-B", "requestType" => "command_execution_approval"}
      })

    e_resolve_a =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :notification,
        method: "request/resolved",
        payload: %{"requestId" => "req-A"}
      })

    result =
      snapshot
      |> Projector.project(e1)
      |> Projector.project(e2)
      |> Projector.project(e_resolve_a)

    session = result.sessions["thread-1"]
    refute Map.has_key?(session.pending_requests, "req-A")
    assert Map.has_key?(session.pending_requests, "req-B")
    assert result.sequence == 3
  end

  # --- Additional session lifecycle variants ---

  test "projects session/started (OpenCode) to status :ready" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-oc" => %Snapshot.Session{
          thread_id: "thread-oc",
          provider: "opencode",
          status: :connecting
        }
      }
    }

    event =
      Event.new(%{
        thread_id: "thread-oc",
        provider: "opencode",
        kind: :session,
        method: "session/started",
        payload: %{"sessionId" => "oc-sess-1"}
      })

    result = Projector.project(snapshot, event)
    assert result.sessions["thread-oc"].status == :ready
  end

  test "projects session/closed to status :closed and clears active_turn" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :running,
          active_turn: %{turn_id: "turn-xyz", status: :running}
        }
      }
    }

    event =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :session,
        method: "session/closed",
        payload: %{}
      })

    result = Projector.project(snapshot, event)
    session = result.sessions["thread-1"]
    assert session.status == :closed
    assert session.active_turn == nil
  end

  test "projects session/error to status :error" do
    snapshot = %Snapshot{
      sessions: %{
        "thread-1" => %Snapshot.Session{
          thread_id: "thread-1",
          provider: "opencode",
          status: :connecting
        }
      }
    }

    event =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :session,
        method: "session/error",
        payload: %{"message" => "binary not found"}
      })

    result = Projector.project(snapshot, event)
    assert result.sessions["thread-1"].status == :error
  end

  test "parse_runtime_mode: full-access and full_access both map to :full_access" do
    for runtime_mode_str <- ["full-access", "full_access"] do
      snapshot = %Snapshot{}

      event =
        Event.new(%{
          thread_id: "thread-1",
          provider: "opencode",
          kind: :session,
          method: "session/connecting",
          payload: %{"runtimeMode" => runtime_mode_str}
        })

      result = Projector.project(snapshot, event)

      assert result.sessions["thread-1"].runtime_mode == :full_access,
             "expected :full_access for runtimeMode=#{inspect(runtime_mode_str)}"
    end
  end

  test "parse_runtime_mode: unknown values default to :approval_required" do
    snapshot = %Snapshot{}

    event =
      Event.new(%{
        thread_id: "thread-1",
        provider: "opencode",
        kind: :session,
        method: "session/connecting",
        payload: %{"runtimeMode" => "something-else"}
      })

    result = Projector.project(snapshot, event)
    assert result.sessions["thread-1"].runtime_mode == :approval_required
  end

  test "update_session is a no-op when thread does not exist in snapshot" do
    snapshot = %Snapshot{sessions: %{}}

    event =
      Event.new(%{
        thread_id: "nonexistent-thread",
        provider: "codex",
        kind: :session,
        method: "session/ready",
        payload: %{}
      })

    result = Projector.project(snapshot, event)
    # Sequence still increments, but no session was created or modified
    assert result.sequence == 1
    assert map_size(result.sessions) == 0
  end
end
