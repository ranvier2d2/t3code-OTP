defmodule HarnessWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :harness

  socket "/socket", HarnessWeb.HarnessSocket,
    websocket: [timeout: :infinity],
    longpoll: false

  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Phoenix.json_library()

  plug :route

  defp route(%{request_path: "/api/snapshot"} = conn, _opts) do
    snapshot = Harness.SnapshotServer.get_snapshot()
    json_response(conn, 200, snapshot)
  end

  defp route(%{request_path: "/api/session/list"} = conn, _opts) do
    sessions = Harness.SessionManager.list_sessions()
    json_response(conn, 200, %{sessions: sessions})
  end

  defp route(%{request_path: "/api/session/start", method: "POST"} = conn, _opts) do
    params = conn.body_params
    case Harness.SessionManager.start_session(params) do
      {:ok, session} -> json_response(conn, 200, %{ok: true, session: session})
      {:error, reason} -> json_response(conn, 400, %{ok: false, error: reason})
    end
  end

  defp route(%{request_path: "/api/session/sendTurn", method: "POST"} = conn, _opts) do
    thread_id = conn.body_params["threadId"]

    if is_nil(thread_id) do
      json_response(conn, 400, %{ok: false, error: "Missing threadId"})
    else
      case Harness.SessionManager.send_turn(thread_id, conn.body_params) do
        {:ok, result} -> json_response(conn, 200, %{ok: true, result: result})
        {:error, reason} -> json_response(conn, 400, %{ok: false, error: reason})
      end
    end
  end

  defp route(%{request_path: "/api/session/stop", method: "POST"} = conn, _opts) do
    thread_id = conn.body_params["threadId"]

    if is_nil(thread_id) do
      json_response(conn, 400, %{ok: false, error: "Missing threadId"})
    else
      case Harness.SessionManager.stop_session(thread_id) do
        :ok -> json_response(conn, 200, %{ok: true})
        {:error, reason} -> json_response(conn, 400, %{ok: false, error: reason})
      end
    end
  end

  defp route(%{request_path: "/api/session/stop-all", method: "POST"} = conn, _opts) do
    Harness.SessionManager.stop_all()
    json_response(conn, 200, %{ok: true})
  end

  defp route(%{request_path: "/api/metrics"} = conn, _opts) do
    metrics = Harness.Metrics.collect()
    json_response(conn, 200, metrics)
  end

  defp route(%{request_path: "/"} = conn, _opts) do
    conn
    |> Plug.Conn.put_resp_content_type("text/plain")
    |> Plug.Conn.send_resp(200, "harness ok")
  end

  defp route(conn, _opts) do
    conn
    |> Plug.Conn.put_resp_content_type("text/plain")
    |> Plug.Conn.send_resp(404, "not found")
  end

  defp json_response(conn, status, data) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(data))
  end
end
