defmodule Harness.OpenCode.RuntimeRegistry do
  @moduledoc """
  Tracks shared OpenCode runtime processes by runtime key.

  Maintains a mapping from `RuntimeKey.t()` → runtime PID with reference
  counting. When the last thread wrapper releases its lease, the runtime
  becomes eligible for idle-TTL shutdown.

  Uses an ETS table for lock-free reads and a GenServer for serialized writes.
  """
  use GenServer
  require Logger

  alias Harness.OpenCode.RuntimeKey

  @table __MODULE__

  # --- Public API ---

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Look up the runtime PID for a given runtime key.
  Returns `{:ok, pid}` or `:error` if no runtime is registered.
  """
  @spec lookup(RuntimeKey.t()) :: {:ok, pid()} | :error
  def lookup(%RuntimeKey{} = key) do
    str_key = RuntimeKey.to_string(key)

    case :ets.lookup(@table, str_key) do
      [{^str_key, pid, _ref_count}] when is_pid(pid) ->
        if Process.alive?(pid), do: {:ok, pid}, else: :error

      _ ->
        :error
    end
  end

  @doc """
  Register a runtime PID for a given runtime key with an initial ref count of 1.
  Returns `:ok` or `{:error, :already_registered}`.
  """
  @spec register(RuntimeKey.t(), pid()) :: :ok | {:error, :already_registered}
  def register(%RuntimeKey{} = key, pid) when is_pid(pid) do
    GenServer.call(__MODULE__, {:register, key, pid})
  end

  @doc """
  Increment the reference count for a runtime key (new thread leasing the runtime).
  Returns `{:ok, new_count}` or `{:error, :not_found}`.
  """
  @spec increment_ref(RuntimeKey.t()) :: {:ok, non_neg_integer()} | {:error, :not_found}
  def increment_ref(%RuntimeKey{} = key) do
    GenServer.call(__MODULE__, {:increment_ref, key})
  end

  @doc """
  Decrement the reference count for a runtime key (thread releasing its lease).
  Returns `{:ok, new_count}` or `{:error, :not_found}`.
  When count reaches 0, the runtime becomes eligible for idle cleanup.
  """
  @spec decrement_ref(RuntimeKey.t()) :: {:ok, non_neg_integer()} | {:error, :not_found}
  def decrement_ref(%RuntimeKey{} = key) do
    GenServer.call(__MODULE__, {:decrement_ref, key})
  end

  @doc """
  Remove a runtime key from the registry entirely.
  Called when runtime shuts down.
  """
  @spec unregister(RuntimeKey.t()) :: :ok
  def unregister(%RuntimeKey{} = key) do
    GenServer.call(__MODULE__, {:unregister, key})
  end

  @doc """
  Get the current reference count for a runtime key.
  Returns the count or 0 if not found.
  """
  @spec ref_count(RuntimeKey.t()) :: non_neg_integer()
  def ref_count(%RuntimeKey{} = key) do
    str_key = RuntimeKey.to_string(key)

    case :ets.lookup(@table, str_key) do
      [{^str_key, _pid, count}] -> count
      _ -> 0
    end
  end

  @doc """
  List all registered runtimes. Returns a list of `{key_string, pid, ref_count}` tuples.
  """
  @spec list_all() :: [{String.t(), pid(), non_neg_integer()}]
  def list_all do
    :ets.tab2list(@table)
  end

  # --- GenServer Callbacks ---

  @impl true
  def init(_opts) do
    table = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{table: table, monitors: %{}}}
  end

  @impl true
  def handle_call({:register, key, pid}, _from, state) do
    str_key = RuntimeKey.to_string(key)

    case :ets.lookup(@table, str_key) do
      [{^str_key, existing_pid, _}] when is_pid(existing_pid) ->
        if Process.alive?(existing_pid) do
          {:reply, {:error, :already_registered}, state}
        else
          # Stale entry — replace it
          do_register(str_key, pid, state)
        end

      _ ->
        do_register(str_key, pid, state)
    end
  end

  @impl true
  def handle_call({:increment_ref, key}, _from, state) do
    str_key = RuntimeKey.to_string(key)

    case :ets.lookup(@table, str_key) do
      [{^str_key, pid, count}] ->
        new_count = count + 1
        :ets.insert(@table, {str_key, pid, new_count})
        {:reply, {:ok, new_count}, state}

      _ ->
        {:reply, {:error, :not_found}, state}
    end
  end

  @impl true
  def handle_call({:decrement_ref, key}, _from, state) do
    str_key = RuntimeKey.to_string(key)

    case :ets.lookup(@table, str_key) do
      [{^str_key, pid, count}] ->
        new_count = max(count - 1, 0)
        :ets.insert(@table, {str_key, pid, new_count})
        {:reply, {:ok, new_count}, state}

      _ ->
        {:reply, {:error, :not_found}, state}
    end
  end

  @impl true
  def handle_call({:unregister, key}, _from, state) do
    str_key = RuntimeKey.to_string(key)
    :ets.delete(@table, str_key)

    # Clean up monitor if any
    state =
      case Map.pop(state.monitors, str_key) do
        {nil, monitors} -> %{state | monitors: monitors}
        {ref, monitors} ->
          Process.demonitor(ref, [:flush])
          %{state | monitors: monitors}
      end

    {:reply, :ok, state}
  end

  # Runtime process died — clean up its registry entry
  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    # Find which key this monitor belongs to
    case Enum.find(state.monitors, fn {_key, mon_ref} -> mon_ref == ref end) do
      {str_key, _} ->
        Logger.warning("Runtime process died, removing registry entry: #{str_key}")
        :ets.delete(@table, str_key)
        {:noreply, %{state | monitors: Map.delete(state.monitors, str_key)}}

      nil ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # --- Internals ---

  defp do_register(str_key, pid, state) do
    :ets.insert(@table, {str_key, pid, 1})
    ref = Process.monitor(pid)
    state = %{state | monitors: Map.put(state.monitors, str_key, ref)}
    {:reply, :ok, state}
  end
end
