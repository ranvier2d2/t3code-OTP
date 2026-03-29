defmodule HarnessWeb.HarnessChannel do
  @moduledoc """
  Phoenix Channel for harness operations.

  Node joins "harness:lobby" and sends commands to manage provider sessions.
  Events from providers are pushed back through this channel.
  """
  use HarnessWeb, :channel

  alias Harness.SessionManager
  alias Harness.SnapshotServer

  @impl true
  def join("harness:lobby", _params, socket) do
    # Subscribe to harness events so we can push them to Node
    Phoenix.PubSub.subscribe(Harness.PubSub, "harness:events")
    {:ok, socket}
  end

  # --- Session Commands ---

  @impl true
  def handle_in("session.start", params, socket) do
    case SessionManager.start_session(params) do
      {:ok, session} ->
        {:reply, {:ok, %{session: session}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("session.sendTurn", params, socket) do
    case Map.get(params, "threadId") do
      nil ->
        {:reply, {:error, %{message: "Missing required param: threadId"}}, socket}

      thread_id ->
        case SessionManager.send_turn(thread_id, params) do
          {:ok, result} ->
            {:reply, {:ok, result}, socket}

          {:error, reason} ->
            {:reply, {:error, %{message: format_error(reason)}}, socket}
        end
    end
  end

  @impl true
  def handle_in("session.interrupt", params, socket) do
    case Map.get(params, "threadId") do
      nil ->
        {:reply, {:error, %{message: "Missing required param: threadId"}}, socket}

      thread_id ->
        turn_id = Map.get(params, "turnId")

        case SessionManager.interrupt_turn(thread_id, turn_id) do
          :ok ->
            {:reply, {:ok, %{}}, socket}

          {:error, reason} ->
            {:reply, {:error, %{message: format_error(reason)}}, socket}
        end
    end
  end

  @impl true
  def handle_in("session.respondToApproval", params, socket) do
    with thread_id when not is_nil(thread_id) <- Map.get(params, "threadId"),
         request_id when not is_nil(request_id) <- Map.get(params, "requestId"),
         decision when not is_nil(decision) <- Map.get(params, "decision") do
      case SessionManager.respond_to_approval(thread_id, request_id, decision) do
        :ok ->
          {:reply, {:ok, %{}}, socket}

        {:error, reason} ->
          {:reply, {:error, %{message: format_error(reason)}}, socket}
      end
    else
      nil ->
        missing =
          cond do
            is_nil(Map.get(params, "threadId")) -> "threadId"
            is_nil(Map.get(params, "requestId")) -> "requestId"
            true -> "decision"
          end

        {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
    end
  end

  @impl true
  def handle_in("session.respondToUserInput", params, socket) do
    with thread_id when not is_nil(thread_id) <- Map.get(params, "threadId"),
         request_id when not is_nil(request_id) <- Map.get(params, "requestId"),
         answers when not is_nil(answers) <- Map.get(params, "answers") do
      case SessionManager.respond_to_user_input(thread_id, request_id, answers) do
        :ok ->
          {:reply, {:ok, %{}}, socket}

        {:error, reason} ->
          {:reply, {:error, %{message: format_error(reason)}}, socket}
      end
    else
      nil ->
        missing =
          cond do
            is_nil(Map.get(params, "threadId")) -> "threadId"
            is_nil(Map.get(params, "requestId")) -> "requestId"
            true -> "answers"
          end

        {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
    end
  end

  @impl true
  def handle_in("session.stop", params, socket) do
    case Map.get(params, "threadId") do
      nil ->
        {:reply, {:error, %{message: "Missing required param: threadId"}}, socket}

      thread_id ->
        case SessionManager.stop_session(thread_id) do
          :ok ->
            {:reply, {:ok, %{}}, socket}

          {:error, reason} ->
            {:reply, {:error, %{message: format_error(reason)}}, socket}
        end
    end
  end

  @impl true
  def handle_in("session.readThread", params, socket) do
    case Map.get(params, "threadId") do
      nil ->
        {:reply, {:error, %{message: "Missing required param: threadId"}}, socket}

      thread_id ->
        case SessionManager.read_thread(thread_id) do
          {:ok, thread} ->
            {:reply, {:ok, %{thread: thread}}, socket}

          {:error, reason} ->
            {:reply, {:error, %{message: format_error(reason)}}, socket}
        end
    end
  end

  @impl true
  def handle_in("session.rollbackThread", params, socket) do
    with thread_id when not is_nil(thread_id) <- Map.get(params, "threadId"),
         num_turns when not is_nil(num_turns) <- Map.get(params, "numTurns") do
      case SessionManager.rollback_thread(thread_id, num_turns) do
        {:ok, thread} ->
          {:reply, {:ok, %{thread: thread}}, socket}

        {:error, reason} ->
          {:reply, {:error, %{message: format_error(reason)}}, socket}
      end
    else
      nil ->
        missing =
          if is_nil(Map.get(params, "threadId")), do: "threadId", else: "numTurns"

        {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
    end
  end

  @impl true
  def handle_in("session.listSessions", _params, socket) do
    sessions = SessionManager.list_sessions()
    {:reply, {:ok, %{sessions: sessions}}, socket}
  end

  @impl true
  def handle_in("session.stopAll", _params, socket) do
    SessionManager.stop_all()
    {:reply, {:ok, %{}}, socket}
  end

  # --- Provider Model Discovery ---

  @impl true
  def handle_in("provider.listModels", %{"provider" => provider}, socket) do
    case Harness.ModelDiscovery.list_models(provider) do
      {:ok, models} ->
        {:reply, {:ok, %{models: models}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("provider.listModels", _params, socket) do
    {:reply, {:error, %{message: "Missing required param: provider"}}, socket}
  end

  # --- MCP Management (OpenCode only) ---

  @impl true
  def handle_in("mcp.status", %{"threadId" => thread_id}, socket) do
    case SessionManager.mcp_status(thread_id) do
      {:ok, data} ->
        {:reply, {:ok, %{status: data}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("mcp.status", _params, socket) do
    {:reply, {:error, %{message: "Missing required param: threadId"}}, socket}
  end

  @impl true
  def handle_in("mcp.add", %{"threadId" => thread_id, "name" => name, "config" => config}, socket) do
    case SessionManager.mcp_add(thread_id, name, config) do
      {:ok, data} ->
        {:reply, {:ok, data}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("mcp.add", params, socket) do
    missing =
      cond do
        is_nil(Map.get(params, "threadId")) -> "threadId"
        is_nil(Map.get(params, "name")) -> "name"
        true -> "config"
      end

    {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
  end

  @impl true
  def handle_in("mcp.connect", %{"threadId" => thread_id, "name" => name}, socket) do
    case SessionManager.mcp_connect(thread_id, name) do
      :ok ->
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("mcp.connect", params, socket) do
    missing = if is_nil(Map.get(params, "threadId")), do: "threadId", else: "name"
    {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
  end

  @impl true
  def handle_in("mcp.disconnect", %{"threadId" => thread_id, "name" => name}, socket) do
    case SessionManager.mcp_disconnect(thread_id, name) do
      :ok ->
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{message: format_error(reason)}}, socket}
    end
  end

  @impl true
  def handle_in("mcp.disconnect", params, socket) do
    missing = if is_nil(Map.get(params, "threadId")), do: "threadId", else: "name"
    {:reply, {:error, %{message: "Missing required param: #{missing}"}}, socket}
  end

  # --- Snapshot ---

  @impl true
  def handle_in("snapshot.get", _params, socket) do
    snapshot = SnapshotServer.get_snapshot()
    {:reply, {:ok, %{snapshot: snapshot}}, socket}
  end

  @doc """
  Replay events since a given sequence number.
  Used by clients to recover events lost during WebSocket disconnection.
  """
  @impl true
  def handle_in("events.replay", %{"afterSeq" => after_seq}, socket) when is_integer(after_seq) do
    case SnapshotServer.replay_since(after_seq) do
      {:ok, current_seq, events} ->
        {:reply, {:ok, %{currentSeq: current_seq, events: events}}, socket}

      {:gap, current_seq, oldest_seq} ->
        {:reply,
         {:error,
          %{
            message:
              "Event gap: requested seq #{after_seq} but oldest available is #{oldest_seq}",
            currentSeq: current_seq,
            oldestSeq: oldest_seq,
            requiresFullSync: true
          }}, socket}
    end
  end

  @impl true
  def handle_in("events.replay", _params, socket) do
    {:reply, {:error, %{message: "Missing or invalid required param: afterSeq (integer)"}},
     socket}
  end

  # --- PubSub → Channel Push ---

  @impl true
  def handle_info({:harness_event, event}, socket) do
    push(socket, "harness.event", event)
    {:noreply, socket}
  end

  @impl true
  def handle_info({:harness_session_changed, data}, socket) do
    push(socket, "harness.session.changed", data)
    {:noreply, socket}
  end

  @impl true
  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  defp format_error(reason) when is_binary(reason), do: reason
  defp format_error({:provider_mismatch, other}), do: "Only supports opencode, got: #{other}"
  defp format_error(reason), do: inspect(reason)
end
