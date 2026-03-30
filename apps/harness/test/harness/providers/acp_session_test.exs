defmodule Harness.Providers.AcpSessionTest do
  use ExUnit.Case, async: true

  alias Harness.Providers.AcpSession

  test "exports the provider session callbacks used by SessionManager" do
    Code.ensure_loaded!(AcpSession)

    assert function_exported?(AcpSession, :start_link, 1)
    assert function_exported?(AcpSession, :wait_for_ready, 1)
    assert function_exported?(AcpSession, :wait_for_ready, 2)
    assert function_exported?(AcpSession, :send_turn, 2)
    assert function_exported?(AcpSession, :interrupt_turn, 3)
    assert function_exported?(AcpSession, :respond_to_approval, 3)
    assert function_exported?(AcpSession, :respond_to_user_input, 3)
    assert function_exported?(AcpSession, :read_thread, 2)
    assert function_exported?(AcpSession, :rollback_thread, 3)
  end

  test "reports rollback as unsupported" do
    assert {:error, "Rollback not supported for Cursor ACP provider"} =
             AcpSession.rollback_thread(self(), "thread-1", 1)
  end
end
