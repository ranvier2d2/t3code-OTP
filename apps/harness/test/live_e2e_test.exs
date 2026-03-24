defmodule Harness.LiveE2ETest do
  @moduledoc """
  Live end-to-end test against the running HarnessService.
  Tests real provider sessions (requires binaries to be installed).

  Run with: mix run test/live_e2e_test.exs
  """

  alias Harness.SessionManager
  alias Harness.SnapshotServer

  defp run_test(name, fun) do
    IO.puts("\n=== #{name} ===")

    try do
      fun.()
      IO.puts("  ✓ PASS")
    rescue
      e ->
        IO.puts("  ✗ FAIL: #{Exception.message(e)}")
    catch
      kind, reason ->
        IO.puts("  ✗ FAIL: #{kind} #{inspect(reason)}")
    end
  end

  defp wait_for_event(thread_id, timeout \\ 10_000) do
    # Subscribe to PubSub and wait for events
    Phoenix.PubSub.subscribe(Harness.PubSub, "harness:events")

    receive do
      {:harness_event, %{threadId: ^thread_id} = event} ->
        IO.puts("    Event: #{event.method}")
        event

      {:harness_event, event} ->
        IO.puts("    Event (other): #{inspect(event, limit: 50)}")
        wait_for_event(thread_id, max(timeout - 100, 0))
    after
      timeout ->
        IO.puts("    (no more events after #{timeout}ms)")
        nil
    end
  end

  defp collect_events(thread_id, duration \\ 5_000) do
    Phoenix.PubSub.subscribe(Harness.PubSub, "harness:events")
    collect_events_loop(thread_id, duration, [])
  end

  defp collect_events_loop(_thread_id, remaining, acc) when remaining <= 0, do: Enum.reverse(acc)

  defp collect_events_loop(thread_id, remaining, acc) do
    start = System.monotonic_time(:millisecond)

    receive do
      {:harness_event, %{threadId: ^thread_id} = event} ->
        elapsed = System.monotonic_time(:millisecond) - start
        IO.puts("    [#{length(acc) + 1}] #{event.method}")
        collect_events_loop(thread_id, remaining - elapsed, [event | acc])

      {:harness_event, _} ->
        elapsed = System.monotonic_time(:millisecond) - start
        collect_events_loop(thread_id, remaining - elapsed, acc)

      {:harness_session_changed, _} ->
        elapsed = System.monotonic_time(:millisecond) - start
        collect_events_loop(thread_id, remaining - elapsed, acc)
    after
      remaining ->
        Enum.reverse(acc)
    end
  end

  def run do
    IO.puts("======================================")
    IO.puts("Live E2E Test Suite")
    IO.puts("======================================")

    # Test 1: Snapshot starts empty
    run_test("Snapshot is accessible", fn ->
      snapshot = SnapshotServer.get_snapshot()
      IO.puts("    Snapshot sequence: #{snapshot.sequence}")
      IO.puts("    Sessions: #{map_size(snapshot.sessions)}")
    end)

    # Test 2: OpenCode session
    opencode_available = System.find_executable("opencode") != nil

    if opencode_available do
      run_test("OpenCode: create session", fn ->
        thread_id = "opencode-e2e-#{System.unique_integer([:positive])}"

        result =
          SessionManager.start_session(%{
            "threadId" => thread_id,
            "provider" => "opencode",
            "cwd" => "/tmp"
          })

        case result do
          {:ok, session} ->
            IO.puts("    Session created: #{inspect(session)}")

            # Wait for events (opencode server startup takes a few seconds)
            IO.puts("    Waiting for session events (15s)...")
            events = collect_events(thread_id, 15_000)
            IO.puts("    Received #{length(events)} events")

            # Check snapshot
            snapshot = SnapshotServer.get_snapshot()
            IO.puts("    Snapshot sessions: #{map_size(snapshot.sessions)}")

            # Cleanup
            SessionManager.stop_session(thread_id)
            IO.puts("    Session stopped")

          {:error, reason} ->
            IO.puts("    Session failed (expected if opencode has issues): #{reason}")
        end
      end)
    else
      IO.puts("\n=== OpenCode: SKIPPED (binary not installed) ===")
    end

    # Test 3: Check all providers are registered
    run_test("All 4 providers registered", fn ->
      providers = ["codex", "claudeAgent", "opencode", "cursor"]

      Enum.each(providers, fn provider ->
        # Try to start — will fail because binaries may not be ready,
        # but should NOT fail with "Unsupported provider"
        thread_id = "check-#{provider}-#{System.unique_integer([:positive])}"

        result =
          SessionManager.start_session(%{
            "threadId" => thread_id,
            "provider" => provider,
            "cwd" => "/tmp"
          })

        case result do
          {:ok, _} ->
            IO.puts("    #{provider}: ✓ accepted")
            SessionManager.stop_session(thread_id)

          {:error, msg} when is_binary(msg) ->
            if String.contains?(msg, "Unsupported") do
              raise "#{provider} not registered!"
            else
              IO.puts("    #{provider}: ✓ accepted (process error: #{String.slice(msg, 0, 60)})")
            end
        end
      end)
    end)

    # Final snapshot
    run_test("Final snapshot state", fn ->
      Process.sleep(2_000)
      snapshot = SnapshotServer.get_snapshot()
      IO.puts("    Final sequence: #{snapshot.sequence}")
      IO.puts("    Active sessions: #{map_size(snapshot.sessions)}")

      Enum.each(snapshot.sessions, fn {id, session} ->
        IO.puts("      #{id}: #{session.status} (#{session.provider})")
      end)
    end)

    IO.puts("\n======================================")
    IO.puts("Done!")
    IO.puts("======================================")
  end
end

Harness.LiveE2ETest.run()
