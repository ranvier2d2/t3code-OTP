defmodule Harness.Providers.OpenCodeRuntimeTest do
  use ExUnit.Case, async: true

  alias Harness.Providers.OpenCodeRuntime

  setup_all do
    Code.ensure_loaded!(OpenCodeRuntime)
    :ok
  end

  test "exports the shared runtime public API" do
    assert function_exported?(OpenCodeRuntime, :start_link, 1)
    assert function_exported?(OpenCodeRuntime, :lease_and_subscribe, 4)
    assert function_exported?(OpenCodeRuntime, :release, 2)
    assert function_exported?(OpenCodeRuntime, :wait_for_ready, 1)
    assert function_exported?(OpenCodeRuntime, :wait_for_ready, 2)
    assert function_exported?(OpenCodeRuntime, :get_base_url, 1)
    assert function_exported?(OpenCodeRuntime, :get_runtime_key, 1)
  end

  test "exports session CRUD operations" do
    assert function_exported?(OpenCodeRuntime, :create_session, 2)
    assert function_exported?(OpenCodeRuntime, :verify_session, 2)
    assert function_exported?(OpenCodeRuntime, :delete_session, 2)
    assert function_exported?(OpenCodeRuntime, :send_prompt, 3)
    assert function_exported?(OpenCodeRuntime, :abort_session, 2)
    assert function_exported?(OpenCodeRuntime, :revert_session, 2)
    assert function_exported?(OpenCodeRuntime, :reply_to_permission, 4)
    assert function_exported?(OpenCodeRuntime, :fetch_messages, 2)
    assert function_exported?(OpenCodeRuntime, :get_session, 2)
  end

  test "exports MCP management operations" do
    assert function_exported?(OpenCodeRuntime, :mcp_status, 1)
    assert function_exported?(OpenCodeRuntime, :mcp_add, 3)
    assert function_exported?(OpenCodeRuntime, :mcp_connect, 2)
    assert function_exported?(OpenCodeRuntime, :mcp_disconnect, 2)
    assert function_exported?(OpenCodeRuntime, :fetch_providers, 1)
  end
end
