defmodule Harness.OpenCode.RuntimeKey do
  @moduledoc """
  Builds a normalized, comparable key that uniquely identifies an OpenCode
  runtime configuration.

  Two threads whose runtime keys match can safely share one `opencode serve`
  process. Key components:

  - `cwd`              — working directory for the OpenCode process
  - `binary_path`      — resolved path to the `opencode` binary
  - `config_path`      — value of `OPENCODE_CONFIG` env var (or nil)
  - `mcp_config_hash`  — deterministic hash of the MCP config map (or nil)
  """

  @enforce_keys [:cwd, :binary_path]
  defstruct [:cwd, :binary_path, :config_path, :mcp_config_hash]

  @type t :: %__MODULE__{
          cwd: String.t(),
          binary_path: String.t(),
          config_path: String.t() | nil,
          mcp_config_hash: String.t() | nil
        }

  @doc """
  Build a runtime key from the session start params map.

  Extracts `cwd`, resolves the binary path, reads the OpenCode config path
  from `providerOptions.opencode.configPath`, and hashes the `mcp_config`
  map for deterministic comparison.
  """
  @spec from_params(map(), map()) :: t()
  def from_params(params, opts \\ %{}) do
    cwd = Map.get(params, "cwd", File.cwd!())
    binary_path = resolve_binary(params, opts)
    config_path = get_config_path(params)
    mcp_config = Map.get(params, "mcp_config")

    %__MODULE__{
      cwd: normalize_path(cwd),
      binary_path: binary_path,
      config_path: config_path,
      mcp_config_hash: hash_mcp_config(mcp_config)
    }
  end

  @doc """
  Convert the key to a string suitable for use as a Registry key or ETS lookup.
  """
  @spec to_string(t()) :: String.t()
  def to_string(%__MODULE__{} = key) do
    parts = [
      key.cwd,
      key.binary_path,
      key.config_path || "",
      key.mcp_config_hash || ""
    ]

    Enum.join(parts, "|")
  end

  # --- Internals ---

  defp resolve_binary(params, opts) do
    provider_options = Map.get(params, "providerOptions", %{})
    opencode_options = Map.get(provider_options, "opencode", %{})

    Map.get(opts, :binary_path) ||
      Map.get(opencode_options, "binaryPath") ||
      System.find_executable("opencode") ||
      "opencode"
  end

  defp get_config_path(params) do
    path = get_in(params, ["providerOptions", "opencode", "configPath"])
    if is_binary(path) and path != "", do: path, else: nil
  end

  defp normalize_path(path) when is_binary(path), do: Path.expand(path)
  defp normalize_path(path), do: path

  defp hash_mcp_config(nil), do: nil
  defp hash_mcp_config(config) when config == %{}, do: nil

  defp hash_mcp_config(config) when is_map(config) do
    config
    |> canonical_term()
    |> :erlang.term_to_binary()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
    |> String.slice(0, 16)
  end

  defp hash_mcp_config(_), do: nil

  # Sort map keys recursively for deterministic hashing regardless of
  # construction order. Converts maps to sorted keyword lists so
  # term_to_binary produces identical output for logically equal configs.
  defp canonical_term(map) when is_map(map) do
    map
    |> Enum.sort_by(fn {k, _} -> k end)
    |> Enum.map(fn {k, v} -> {k, canonical_term(v)} end)
  end

  defp canonical_term(list) when is_list(list), do: Enum.map(list, &canonical_term/1)
  defp canonical_term(value), do: value
end
