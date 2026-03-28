defmodule Harness.Providers.CodexSessionTest do
  use ExUnit.Case, async: true

  alias Harness.Providers.CodexSession

  test "exports the provider session callbacks used by SessionManager" do
    assert function_exported?(CodexSession, :start_link, 1)
    assert function_exported?(CodexSession, :wait_for_ready, 1)
    assert function_exported?(CodexSession, :wait_for_ready, 2)
    assert function_exported?(CodexSession, :send_turn, 2)
    assert function_exported?(CodexSession, :interrupt_turn, 3)
    assert function_exported?(CodexSession, :respond_to_approval, 3)
    assert function_exported?(CodexSession, :respond_to_user_input, 3)
    assert function_exported?(CodexSession, :read_thread, 2)
    assert function_exported?(CodexSession, :rollback_thread, 3)
  end
end
