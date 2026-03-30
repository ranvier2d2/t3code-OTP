defmodule Harness.JsonRpcTest do
  use ExUnit.Case, async: true

  alias Harness.JsonRpc

  test "encodes JSON-RPC requests with integer ids unchanged" do
    message = JsonRpc.encode_request(1, "initialize", %{"hello" => "world"}) |> Jason.decode!()

    assert message == %{
             "jsonrpc" => "2.0",
             "id" => 1,
             "method" => "initialize",
             "params" => %{"hello" => "world"}
           }
  end

  test "encodes notifications without ids" do
    message =
      JsonRpc.encode_notification("session/cancel", %{"sessionId" => "s-1"}) |> Jason.decode!()

    assert message == %{
             "jsonrpc" => "2.0",
             "method" => "session/cancel",
             "params" => %{"sessionId" => "s-1"}
           }
  end

  test "encodes JSON-RPC error responses" do
    message =
      JsonRpc.encode_error_response(8, -32_603, "failed", [%{"detail" => "boom"}])
      |> Jason.decode!()

    assert message == %{
             "jsonrpc" => "2.0",
             "id" => 8,
             "error" => %{
               "code" => -32_603,
               "message" => "failed",
               "data" => [%{"detail" => "boom"}]
             }
           }
  end

  test "decodes request, notification, response, and error response" do
    assert {:request, 42, "session/request_permission", %{"foo" => "bar"}} =
             JsonRpc.decode(
               ~s({"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"foo":"bar"}})
             )

    assert {:notification, "session/update", %{"sessionUpdate" => "agent_thought_chunk"}} =
             JsonRpc.decode(
               ~s({"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_thought_chunk"}})
             )

    assert {:response, 7, %{"sessionId" => "abc"}} =
             JsonRpc.decode(~s({"jsonrpc":"2.0","id":7,"result":{"sessionId":"abc"}}))

    assert {:error_response, 8, %{"code" => -32_603, "message" => "failed"}} =
             JsonRpc.decode(
               ~s({"jsonrpc":"2.0","id":8,"error":{"code":-32603,"message":"failed"}})
             )
  end

  test "returns invalid_message for non JSON-RPC json" do
    assert {:error, :invalid_message} = JsonRpc.decode(~s({"jsonrpc":"2.0"}))
  end
end
