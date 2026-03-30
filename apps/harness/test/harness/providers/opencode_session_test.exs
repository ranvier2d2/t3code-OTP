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

  test "exports stop/1 callback" do
    assert function_exported?(OpenCodeSession, :stop, 1)
  end

  # event_relevant?/2 is private, so we test the struct-level contract:
  # events without "data" and without a recognized "type" should not leak
  # across sessions. We verify the struct shape supports session filtering.
  test "struct includes opencode_session_id for event filtering" do
    session = %OpenCodeSession{}
    assert Map.has_key?(session, :opencode_session_id)
  end

  test "struct has runtime-related fields (Sprint 2 shared runtime)" do
    session = %OpenCodeSession{}
    assert Map.has_key?(session, :runtime_key)
    assert Map.has_key?(session, :runtime_pid)
    assert Map.has_key?(session, :runtime_ref)
    assert Map.has_key?(session, :opencode_session_id)
    # These fields should NOT exist after Sprint 2 refactor (moved to OpenCodeRuntime)
    refute Map.has_key?(session, :port)
    refute Map.has_key?(session, :opencode_port)
    refute Map.has_key?(session, :sse_pid)
    refute Map.has_key?(session, :base_url)
    refute Map.has_key?(session, :binary_path)
  end
end
