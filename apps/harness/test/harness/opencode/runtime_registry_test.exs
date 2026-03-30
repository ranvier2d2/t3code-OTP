defmodule Harness.OpenCode.RuntimeRegistryTest do
  use ExUnit.Case

  alias Harness.OpenCode.RuntimeKey
  alias Harness.OpenCode.RuntimeRegistry

  # We need the registry GenServer running for these tests.
  # The Application supervisor starts it, but we need to ensure
  # we clean up between tests.

  defp make_key(cwd \\ "/tmp/test-#{System.unique_integer([:positive])}") do
    %RuntimeKey{
      cwd: cwd,
      binary_path: "opencode",
      config_path: nil,
      mcp_config_hash: nil
    }
  end

  defp start_dummy_process do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  setup do
    # Ensure RuntimeRegistry is running
    case Process.whereis(RuntimeRegistry) do
      nil ->
        # If not started by app, start it manually
        {:ok, _} = RuntimeRegistry.start_link([])
        :ok

      _pid ->
        :ok
    end

    :ok
  end

  describe "register/2 and lookup/1" do
    test "registers a runtime and looks it up" do
      key = make_key()
      pid = start_dummy_process()

      assert :ok = RuntimeRegistry.register(key, pid)
      assert {:ok, ^pid} = RuntimeRegistry.lookup(key)
    end

    test "returns :error for unregistered key" do
      key = make_key("/tmp/nonexistent-#{System.unique_integer([:positive])}")
      assert :error = RuntimeRegistry.lookup(key)
    end

    test "returns :already_registered for duplicate registration" do
      key = make_key()
      pid1 = start_dummy_process()
      pid2 = start_dummy_process()

      assert :ok = RuntimeRegistry.register(key, pid1)
      assert {:error, :already_registered} = RuntimeRegistry.register(key, pid2)

      # Clean up
      send(pid1, :stop)
      send(pid2, :stop)
    end

    test "allows re-registration after process dies" do
      key = make_key()
      pid1 = start_dummy_process()

      assert :ok = RuntimeRegistry.register(key, pid1)

      # Kill the process
      send(pid1, :stop)
      Process.sleep(50)

      # Now register a new process — should succeed because the old one is dead
      pid2 = start_dummy_process()
      assert :ok = RuntimeRegistry.register(key, pid2)
      assert {:ok, ^pid2} = RuntimeRegistry.lookup(key)

      send(pid2, :stop)
    end
  end

  describe "ref counting" do
    test "starts with ref count 1 after registration" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      assert RuntimeRegistry.ref_count(key) == 1

      send(pid, :stop)
    end

    test "increment_ref increases count" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      assert {:ok, 2} = RuntimeRegistry.increment_ref(key)
      assert RuntimeRegistry.ref_count(key) == 2

      send(pid, :stop)
    end

    test "decrement_ref decreases count" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      RuntimeRegistry.increment_ref(key)
      assert RuntimeRegistry.ref_count(key) == 2

      assert {:ok, 1} = RuntimeRegistry.decrement_ref(key)
      assert RuntimeRegistry.ref_count(key) == 1

      send(pid, :stop)
    end

    test "decrement_ref does not go below 0" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      assert {:ok, 0} = RuntimeRegistry.decrement_ref(key)
      assert {:ok, 0} = RuntimeRegistry.decrement_ref(key)
      assert RuntimeRegistry.ref_count(key) == 0

      send(pid, :stop)
    end

    test "increment_ref returns error for unknown key" do
      key = make_key("/tmp/unknown-#{System.unique_integer([:positive])}")
      assert {:error, :not_found} = RuntimeRegistry.increment_ref(key)
    end

    test "decrement_ref returns error for unknown key" do
      key = make_key("/tmp/unknown-#{System.unique_integer([:positive])}")
      assert {:error, :not_found} = RuntimeRegistry.decrement_ref(key)
    end

    test "ref_count returns 0 for unknown key" do
      key = make_key("/tmp/unknown-#{System.unique_integer([:positive])}")
      assert RuntimeRegistry.ref_count(key) == 0
    end
  end

  describe "unregister/1" do
    test "removes the runtime from the registry" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      assert {:ok, ^pid} = RuntimeRegistry.lookup(key)

      assert :ok = RuntimeRegistry.unregister(key)
      assert :error = RuntimeRegistry.lookup(key)
      assert RuntimeRegistry.ref_count(key) == 0

      send(pid, :stop)
    end

    test "unregister is idempotent" do
      key = make_key()
      assert :ok = RuntimeRegistry.unregister(key)
    end
  end

  describe "list_all/0" do
    test "returns all registered runtimes" do
      key1 = make_key("/tmp/list-test-a-#{System.unique_integer([:positive])}")
      key2 = make_key("/tmp/list-test-b-#{System.unique_integer([:positive])}")
      pid1 = start_dummy_process()
      pid2 = start_dummy_process()

      RuntimeRegistry.register(key1, pid1)
      RuntimeRegistry.register(key2, pid2)

      all = RuntimeRegistry.list_all()
      str_key1 = RuntimeKey.to_string(key1)
      str_key2 = RuntimeKey.to_string(key2)

      assert Enum.any?(all, fn {k, _, _} -> k == str_key1 end)
      assert Enum.any?(all, fn {k, _, _} -> k == str_key2 end)

      # Clean up
      RuntimeRegistry.unregister(key1)
      RuntimeRegistry.unregister(key2)
      send(pid1, :stop)
      send(pid2, :stop)
    end
  end

  describe "process monitoring" do
    test "cleans up registry when monitored process dies" do
      key = make_key()
      pid = start_dummy_process()

      RuntimeRegistry.register(key, pid)
      assert {:ok, ^pid} = RuntimeRegistry.lookup(key)

      # Kill the process
      Process.exit(pid, :kill)
      # Give the registry time to process the DOWN message
      Process.sleep(100)

      assert :error = RuntimeRegistry.lookup(key)
    end
  end
end
