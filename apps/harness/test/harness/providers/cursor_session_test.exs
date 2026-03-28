defmodule Harness.Providers.CursorSessionTest do
  use ExUnit.Case, async: true

  alias Harness.Providers.CursorSession

  test "exports the provider session callbacks used by SessionManager" do
    assert function_exported?(CursorSession, :start_link, 1)
    assert function_exported?(CursorSession, :wait_for_ready, 1)
    assert function_exported?(CursorSession, :wait_for_ready, 2)
    assert function_exported?(CursorSession, :send_turn, 2)
    assert function_exported?(CursorSession, :interrupt_turn, 3)
    assert function_exported?(CursorSession, :respond_to_approval, 3)
    assert function_exported?(CursorSession, :respond_to_user_input, 3)
    assert function_exported?(CursorSession, :read_thread, 2)
    assert function_exported?(CursorSession, :rollback_thread, 3)
  end

  test "reports rollback as unsupported" do
    assert {:error, "Rollback not supported for Cursor provider"} =
             CursorSession.rollback_thread(self(), "thread-1", 1)
  end
end
