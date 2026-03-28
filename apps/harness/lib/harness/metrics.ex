defmodule Harness.Metrics do
  @moduledoc """
  Collects BEAM runtime metrics for stress testing.

  Exposes per-process memory, GC stats, scheduler utilization,
  and SnapshotServer health — all the numbers needed to compare
  OTP session isolation vs shared-heap runtimes.
  """

  @doc """
  Collect a full metrics snapshot.
  """
  def collect do
    sessions = session_metrics()

    %{
      beam: beam_metrics(),
      sessions: sessions,
      lifecycle: lifecycle_metrics(sessions),
      snapshot_server: snapshot_server_metrics(),
      timestamp: System.system_time(:millisecond)
    }
  end

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

  defp lifecycle_metrics(sessions) do
    %{
      active_sessions: length(sessions),
      sessions_by_provider: Enum.frequencies_by(sessions, & &1.provider),
      sessions_with_backlog: Enum.count(sessions, &(&1.message_queue_len > 0)),
      total_message_queue_len: Enum.reduce(sessions, 0, &(&1.message_queue_len + &2))
    }
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
