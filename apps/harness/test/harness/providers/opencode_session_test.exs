defmodule Harness.Providers.OpenCodeSessionTest do
  use ExUnit.Case, async: true

  alias Harness.Providers.OpenCodeSession

  test "exports the provider session callbacks used by SessionManager" do
    assert function_exported?(OpenCodeSession, :start_link, 1)
    assert function_exported?(OpenCodeSession, :wait_for_ready, 1)
    assert function_exported?(OpenCodeSession, :wait_for_ready, 2)
    assert function_exported?(OpenCodeSession, :send_turn, 2)
    assert function_exported?(OpenCodeSession, :interrupt_turn, 3)
    assert function_exported?(OpenCodeSession, :respond_to_approval, 3)
    assert function_exported?(OpenCodeSession, :respond_to_user_input, 3)
    assert function_exported?(OpenCodeSession, :read_thread, 2)
    assert function_exported?(OpenCodeSession, :rollback_thread, 3)
  end
end
