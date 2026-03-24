defmodule Harness.E2EChannelTest do
  @moduledoc """
  End-to-end test: connects to the running Phoenix server via Channel,
  joins harness:lobby, sends commands, verifies responses.
  """
  use ExUnit.Case

  alias Phoenix.Channels.GenSocketClient

  @endpoint_url "ws://localhost:4321/socket/websocket"
  @secret "test-secret"

  # We'll test the channel using Phoenix.ChannelTest instead
  # since we have the app running in-process during tests.

  use Phoenix.ChannelTest

  @endpoint HarnessWeb.Endpoint

  setup do
    # Stop all sessions between tests to prevent state leaks
    Harness.SessionManager.stop_all()
    :ok
  end

  test "can join harness:lobby with valid secret" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby", %{
        "secret" => "ignored-in-test"
      })

    assert socket.joined
  end

  test "snapshot.get returns empty snapshot" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref = push(socket, "snapshot.get", %{})
    assert_reply ref, :ok, %{snapshot: snapshot}

    assert snapshot.sequence >= 0
    assert is_map(snapshot.sessions)
  end

  test "session.listSessions returns empty list initially" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref = push(socket, "session.listSessions", %{})
    assert_reply ref, :ok, %{sessions: sessions}

    assert is_list(sessions)
  end

  test "session.start with invalid provider returns error" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref =
      push(socket, "session.start", %{
        "threadId" => "test-thread-1",
        "provider" => "nonexistent",
        "cwd" => "/tmp"
      })

    assert_reply ref, :error, %{message: message}
    assert message =~ "Unsupported provider"
  end

  test "session.start with claudeAgent provider is accepted" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref =
      push(socket, "session.start", %{
        "threadId" => "claude-test-#{System.unique_integer([:positive])}",
        "provider" => "claudeAgent",
        "cwd" => "/tmp",
        "model" => "claude-sonnet-4-6"
      })

    # Should either succeed (if claude is installed) or fail with a process error
    # Either way, it should NOT return "Unsupported provider"
    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: payload} ->
        case status do
          :ok ->
            assert Map.has_key?(payload, :session)

          :error ->
            # Claude binary may not be installed — that's fine for CI
            refute payload.message =~ "Unsupported provider"
        end
    after
      5000 -> flunk("No reply received for session.start")
    end
  end

  test "session.start with opencode provider is accepted" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref =
      push(socket, "session.start", %{
        "threadId" => "opencode-test-#{System.unique_integer([:positive])}",
        "provider" => "opencode",
        "cwd" => "/tmp"
      })

    # Should either succeed or fail with a process error — NOT "Unsupported provider"
    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: payload} ->
        case status do
          :ok ->
            assert Map.has_key?(payload, :session)

          :error ->
            refute payload.message =~ "Unsupported provider"
        end
    after
      10000 -> flunk("No reply received for opencode session.start")
    end
  end

  test "session.start with cursor provider is accepted" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref =
      push(socket, "session.start", %{
        "threadId" => "cursor-test-#{System.unique_integer([:positive])}",
        "provider" => "cursor",
        "cwd" => "/tmp"
      })

    receive do
      %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: payload} ->
        case status do
          :ok ->
            assert Map.has_key?(payload, :session)

          :error ->
            refute payload.message =~ "Unsupported provider"
        end
    after
      5000 -> flunk("No reply received for cursor session.start")
    end
  end

  test "socket connect rejects invalid secret" do
    # Phoenix.ChannelTest's socket/3 bypasses connect/3, so we call it directly.
    assert :error =
             HarnessWeb.HarnessSocket.connect(%{"secret" => "wrong"}, %Phoenix.Socket{}, %{})
  end

  test "socket connect accepts valid secret" do
    expected_secret = Application.get_env(:harness, :harness_secret, "dev-harness-secret")

    assert {:ok, _socket} =
             HarnessWeb.HarnessSocket.connect(
               %{"secret" => expected_secret},
               %Phoenix.Socket{},
               %{}
             )
  end

  test "session.stop for nonexistent session returns error" do
    {:ok, _, socket} =
      socket(HarnessWeb.HarnessSocket, nil, %{})
      |> subscribe_and_join(HarnessWeb.HarnessChannel, "harness:lobby")

    ref = push(socket, "session.stop", %{"threadId" => "nonexistent"})
    assert_reply ref, :error, %{message: message}

    assert message =~ "Session not found"
  end
end
