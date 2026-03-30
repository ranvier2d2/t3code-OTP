defmodule Harness.JsonRpc do
  @moduledoc """
  JSON-RPC 2.0 encode/decode helpers for communicating with provider processes
  (e.g., `codex app-server`) over stdio.
  """

  @doc """
  Encode a JSON-RPC request.
  """
  def encode_request(id, method, params \\ %{}) do
    Jason.encode!(%{
      "jsonrpc" => "2.0",
      "id" => id,
      "method" => method,
      "params" => params
    })
  end

  @doc """
  Encode a JSON-RPC notification (no id).
  """
  def encode_notification(method, params \\ %{}) do
    Jason.encode!(%{
      "jsonrpc" => "2.0",
      "method" => method,
      "params" => params
    })
  end

  @doc """
  Encode a JSON-RPC response (for answering provider requests like approval).
  """
  def encode_response(id, result) do
    Jason.encode!(%{
      "jsonrpc" => "2.0",
      "id" => id,
      "result" => result
    })
  end

  @doc """
  Encode a JSON-RPC error response.
  """
  def encode_error_response(id, code, message, data \\ nil) do
    error =
      %{
        "code" => code,
        "message" => message
      }
      |> then(fn error ->
        if is_nil(data), do: error, else: Map.put(error, "data", data)
      end)

    Jason.encode!(%{
      "jsonrpc" => "2.0",
      "id" => id,
      "error" => error
    })
  end

  @doc """
  Decode a JSON-RPC message from a line of text.
  Returns {:request, id, method, params} | {:notification, method, params} |
          {:response, id, result} | {:error_response, id, error} | {:error, reason}
  """
  def decode(line) when is_binary(line) do
    case Jason.decode(line) do
      {:ok, %{"id" => id, "method" => method} = msg} ->
        {:request, id, method, Map.get(msg, "params", %{})}

      {:ok, %{"method" => method} = msg} ->
        {:notification, method, Map.get(msg, "params", %{})}

      {:ok, %{"id" => id, "result" => result}} ->
        {:response, id, result}

      {:ok, %{"id" => id, "error" => error}} ->
        {:error_response, id, error}

      {:ok, _msg} ->
        {:error, :invalid_message}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
