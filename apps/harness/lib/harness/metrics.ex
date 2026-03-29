defmodule Harness.Metrics do
  @moduledoc """
  Collects BEAM runtime metrics for stress testing.

  Exposes per-process memory, GC stats, scheduler utilization,
  SnapshotServer health, and session lifecycle counters — all
  the numbers needed to compare OTP session isolation vs
  shared-heap runtimes.
  """

  use GenServer

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Start the Metrics counter server (linked to the calling process).
  """
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @doc """
  Collect a full metrics snapshot, including lifecycle counters.
  """
  def collect do
    counters = get_counters()

    %{
      beam: beam_metrics(),
      sessions: session_metrics(),
      snapshot_server: snapshot_server_metrics(),
      lifecycle: counters,
      timestamp: System.system_time(:millisecond)
    }
  end

  @doc """
  Record a session start event for the given provider.
  """
  def record_session_start(provider) when is_binary(provider) do
    safe_cast(:record, {:start, provider})
  end

  @doc """
  Record a session end event for the given provider.
  """
  def record_session_end(provider) when is_binary(provider) do
    safe_cast(:record, {:end, provider})
  end

  @doc """
  Record a session resume event for the given provider.
  """
  def record_session_resume(provider) when is_binary(provider) do
    safe_cast(:record, {:resume, provider})
  end

  @doc """
  Record a turn duration sample (milliseconds) for the given provider.
  """
  def record_turn_duration(provider, duration_ms)
      when is_binary(provider) and is_number(duration_ms) do
    safe_cast(:record_duration, {provider, duration_ms})
  end

  @doc """
  Return the current lifecycle counter map.
  """
  def get_counters do
    if Process.whereis(__MODULE__) do
      GenServer.call(__MODULE__, :get_counters)
    else
      default_counters()
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_opts) do
    {:ok, default_counters()}
  end

  @impl true
  def handle_cast({:record, {event, provider}}, state) do
    key = counter_key(event, provider)
    {:noreply, Map.update(state, key, 1, &(&1 + 1))}
  end

  def handle_cast({:record_duration, {provider, duration_ms}}, state) do
    durations_key = "turn_durations.#{provider}"
    existing = Map.get(state, durations_key, [])
    # Keep last 100 samples to bound memory.
    samples = Enum.take([duration_ms | existing], 100)
    {:noreply, Map.put(state, durations_key, samples)}
  end

  @impl true
  def handle_call(:get_counters, _from, state) do
    {:reply, state, state}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp safe_cast(msg, payload) do
    if Process.whereis(__MODULE__) do
      GenServer.cast(__MODULE__, {msg, payload})
    end

    :ok
  end

  defp counter_key(:start, provider), do: "start_count.#{provider}"
  defp counter_key(:end, provider), do: "end_count.#{provider}"
  defp counter_key(:resume, provider), do: "resume_count.#{provider}"

  defp default_counters, do: %{}

  # --- BEAM-level metrics ---

  defp beam_metrics do
    memory = :erlang.memory()
    {gc_runs, gc_words_reclaimed, _} = :erlang.statistics(:garbage_collection)

    schedulers =
      try do
        # scheduler_wall_time must be enabled first
        :erlang.system_flag(:scheduler_wall_time, true)

        # Take two snapshots with a small delta to compute meaningful utilization.
        # A single cumulative sample is monotonically decreasing over long runs.
        t0 = :erlang.statistics(:scheduler_wall_time_all)
        Process.sleep(100)
        t1 = :erlang.statistics(:scheduler_wall_time_all)

        case {t0, t1} do
          {:undefined, _} ->
            []

          {_, :undefined} ->
            []

          {before, after_} ->
            Enum.zip(Enum.sort(before), Enum.sort(after_))
            |> Enum.map(fn {{_id, a0, t0}, {_id2, a1, t1}} ->
              dt = t1 - t0
              if dt > 0, do: Float.round((a1 - a0) / dt, 4), else: 0.0
            end)
        end
      rescue
        _ -> []
      end

    %{
      total_memory: memory[:total],
      process_memory: memory[:processes],
      system_memory: memory[:system],
      ets_memory: memory[:ets],
      binary_memory: memory[:binary],
      atom_memory: memory[:atom],
      process_count: :erlang.system_info(:process_count),
      scheduler_utilization: schedulers,
      gc_runs: gc_runs,
      gc_words_reclaimed: gc_words_reclaimed
    }
  end

  # --- Per-session metrics ---

  defp session_metrics do
    children = DynamicSupervisor.which_children(Harness.SessionSupervisor)

    Enum.flat_map(children, fn
      {_, pid, _, _} when is_pid(pid) ->
        case process_metrics(pid) do
          nil -> []
          metrics -> [metrics]
        end

      _ ->
        []
    end)
  end

  defp process_metrics(pid) do
    case :erlang.process_info(pid, [
           :memory,
           :heap_size,
           :total_heap_size,
           :message_queue_len,
           :garbage_collection,
           :reductions,
           :dictionary
         ]) do
      nil ->
        nil

      info ->
        gc_info = Keyword.get(info, :garbage_collection, [])
        dict = Keyword.get(info, :dictionary, [])

        # Extract thread_id and provider from process dictionary
        # (GenServers store state internally, but we can check registered names
        #  or use the Registry)
        {thread_id, provider} = extract_session_identity(pid, dict)

        %{
          thread_id: thread_id,
          provider: provider,
          pid: inspect(pid),
          memory: Keyword.get(info, :memory, 0),
          heap_size: Keyword.get(info, :heap_size, 0),
          total_heap_size: Keyword.get(info, :total_heap_size, 0),
          message_queue_len: Keyword.get(info, :message_queue_len, 0),
          gc_count: Keyword.get(gc_info, :minor_gcs, 0),
          reductions: Keyword.get(info, :reductions, 0)
        }
    end
  end

  defp extract_session_identity(pid, _dict) do
    # Look up the pid in the Registry to find thread_id
    case Registry.keys(Harness.SessionRegistry, pid) do
      [thread_id | _] ->
        # Try to get provider from Registry metadata or default
        provider =
          case Registry.lookup(Harness.SessionRegistry, thread_id) do
            [{_pid, metadata}] when is_map(metadata) -> Map.get(metadata, :provider, "unknown")
            [{_pid, provider}] when is_binary(provider) -> provider
            _ -> "unknown"
          end

        {thread_id, provider}

      [] ->
        {"unknown", "unknown"}
    end
  end

  # --- SnapshotServer metrics ---

  defp snapshot_server_metrics do
    pid = Process.whereis(Harness.SnapshotServer)

    if pid do
      case :erlang.process_info(pid, [:memory, :message_queue_len, :heap_size, :reductions]) do
        nil ->
          %{alive: false}

        info ->
          %{
            alive: true,
            memory: Keyword.get(info, :memory, 0),
            message_queue_len: Keyword.get(info, :message_queue_len, 0),
            heap_size: Keyword.get(info, :heap_size, 0),
            reductions: Keyword.get(info, :reductions, 0)
          }
      end
    else
      %{alive: false}
    end
  end
end
