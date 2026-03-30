defmodule Harness.OpenCode.RuntimeKeyTest do
  use ExUnit.Case, async: true

  alias Harness.OpenCode.RuntimeKey

  describe "from_params/2" do
    test "builds a key from minimal params" do
      params = %{"cwd" => "/tmp/project"}
      key = RuntimeKey.from_params(params)

      assert %RuntimeKey{} = key
      assert key.cwd == "/tmp/project"
      assert key.binary_path != nil
      assert key.config_path == nil
      assert key.mcp_config_hash == nil
    end

    test "includes binary_path from providerOptions" do
      params = %{
        "cwd" => "/tmp/project",
        "providerOptions" => %{
          "opencode" => %{"binaryPath" => "/usr/local/bin/opencode"}
        }
      }

      key = RuntimeKey.from_params(params)
      assert key.binary_path == "/usr/local/bin/opencode"
    end

    test "includes config_path from providerOptions" do
      params = %{
        "cwd" => "/tmp/project",
        "providerOptions" => %{
          "opencode" => %{"configPath" => "/home/user/.opencode.json"}
        }
      }

      key = RuntimeKey.from_params(params)
      assert key.config_path == "/home/user/.opencode.json"
    end

    test "hashes mcp_config deterministically" do
      mcp = %{"servers" => %{"my-server" => %{"command" => "node", "args" => ["server.js"]}}}
      params = %{"cwd" => "/tmp/project", "mcp_config" => mcp}

      key1 = RuntimeKey.from_params(params)
      key2 = RuntimeKey.from_params(params)

      assert key1.mcp_config_hash != nil
      assert key1.mcp_config_hash == key2.mcp_config_hash
    end

    test "different mcp_config produces different hash" do
      params1 = %{"cwd" => "/tmp/project", "mcp_config" => %{"a" => 1}}
      params2 = %{"cwd" => "/tmp/project", "mcp_config" => %{"b" => 2}}

      key1 = RuntimeKey.from_params(params1)
      key2 = RuntimeKey.from_params(params2)

      assert key1.mcp_config_hash != key2.mcp_config_hash
    end

    test "mcp_config hash is stable regardless of map key insertion order" do
      # Construct maps with identical content but potentially different internal order
      config_a = Map.new([{"z_last", 1}, {"a_first", 2}, {"m_middle", %{"nested_b" => 10, "nested_a" => 20}}])
      config_b = Map.new([{"a_first", 2}, {"m_middle", %{"nested_a" => 20, "nested_b" => 10}}, {"z_last", 1}])

      params_a = %{"cwd" => "/tmp/project", "mcp_config" => config_a}
      params_b = %{"cwd" => "/tmp/project", "mcp_config" => config_b}

      key_a = RuntimeKey.from_params(params_a)
      key_b = RuntimeKey.from_params(params_b)

      assert key_a.mcp_config_hash == key_b.mcp_config_hash
    end

    test "empty mcp_config produces nil hash" do
      params = %{"cwd" => "/tmp/project", "mcp_config" => %{}}
      key = RuntimeKey.from_params(params)
      assert key.mcp_config_hash == nil
    end

    test "nil mcp_config produces nil hash" do
      params = %{"cwd" => "/tmp/project"}
      key = RuntimeKey.from_params(params)
      assert key.mcp_config_hash == nil
    end

    test "normalizes cwd path" do
      params = %{"cwd" => "/tmp/../tmp/project"}
      key = RuntimeKey.from_params(params)
      assert key.cwd == "/tmp/project"
    end

    test "opts :binary_path overrides providerOptions" do
      params = %{
        "cwd" => "/tmp/project",
        "providerOptions" => %{
          "opencode" => %{"binaryPath" => "/from/params"}
        }
      }

      key = RuntimeKey.from_params(params, %{binary_path: "/from/opts"})
      assert key.binary_path == "/from/opts"
    end
  end

  describe "to_string/1" do
    test "produces a deterministic string representation" do
      key = %RuntimeKey{
        cwd: "/tmp/project",
        binary_path: "opencode",
        config_path: nil,
        mcp_config_hash: nil
      }

      str = RuntimeKey.to_string(key)
      assert is_binary(str)
      assert str == "/tmp/project|opencode||"
    end

    test "includes all components when present" do
      key = %RuntimeKey{
        cwd: "/tmp/project",
        binary_path: "/usr/bin/opencode",
        config_path: "/home/user/.config",
        mcp_config_hash: "abc123"
      }

      str = RuntimeKey.to_string(key)
      assert str == "/tmp/project|/usr/bin/opencode|/home/user/.config|abc123"
    end

    test "same params produce same string" do
      params = %{"cwd" => "/tmp/project", "mcp_config" => %{"x" => 1}}
      key1 = RuntimeKey.from_params(params)
      key2 = RuntimeKey.from_params(params)

      assert RuntimeKey.to_string(key1) == RuntimeKey.to_string(key2)
    end

    test "different cwd produces different string" do
      key1 = RuntimeKey.from_params(%{"cwd" => "/tmp/a"})
      key2 = RuntimeKey.from_params(%{"cwd" => "/tmp/b"})

      assert RuntimeKey.to_string(key1) != RuntimeKey.to_string(key2)
    end
  end
end
