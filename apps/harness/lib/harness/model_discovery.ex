defmodule Harness.ModelDiscovery do
  @moduledoc """
  Discovers available models from provider CLIs.

  Calls provider-specific CLI commands (e.g., `cursor agent models`)
  and parses the output into a normalized list of {slug, name} pairs.
  Results are cached in ETS to avoid repeated CLI calls.
  """

  require Logger

  @cache_table :harness_model_cache
  @cache_ttl_ms :timer.minutes(10)

  # --- Public API ---

  @doc """
  List available models for a provider. Returns cached results if fresh.
  """
  def list_models(provider) when provider in ["cursor", "opencode"] do
    case get_cached(provider) do
      {:ok, models} -> {:ok, models}
      :miss -> fetch_and_cache(provider)
    end
  end

  def list_models(provider) do
    {:error, "Dynamic model discovery not supported for provider: #{provider}"}
  end

  @doc """
  Force refresh the model cache for a provider.
  """
  def refresh(provider) do
    delete_cached(provider)
    fetch_and_cache(provider)
  end

  # --- ETS Cache ---

  def ensure_cache_table do
    case :ets.whereis(@cache_table) do
      :undefined ->
        try do
          :ets.new(@cache_table, [:named_table, :set, :public, read_concurrency: true])
        rescue
          ArgumentError -> :ok
        end

      _ ->
        :ok
    end
  end

  defp get_cached(provider) do
    ensure_cache_table()

    case :ets.lookup(@cache_table, provider) do
      [{^provider, models, cached_at}] ->
        if System.monotonic_time(:millisecond) - cached_at < @cache_ttl_ms do
          {:ok, models}
        else
          :miss
        end

      [] ->
        :miss
    end
  end

  defp set_cached(provider, models) do
    ensure_cache_table()
    :ets.insert(@cache_table, {provider, models, System.monotonic_time(:millisecond)})
  end

  defp delete_cached(provider) do
    ensure_cache_table()
    :ets.delete(@cache_table, provider)
  end

  # --- Provider-specific fetchers ---

  defp fetch_and_cache(provider) do
    case do_fetch(provider) do
      {:ok, models} ->
        set_cached(provider, models)
        Logger.info("Discovered #{length(models)} models for #{provider}")
        {:ok, models}

      {:error, reason} = err ->
        Logger.warning("Failed to discover models for #{provider}: #{inspect(reason)}")
        err
    end
  end

  defp do_fetch("cursor") do
    binary = System.find_executable("cursor") || "cursor"
    fetch_from_cli(binary, ["agent", "--list-models"], &parse_cursor_models/1)
  end

  defp do_fetch("opencode") do
    binary = System.find_executable("opencode") || "opencode"
    fetch_from_cli(binary, ["models"], &parse_opencode_models/1)
  end

  defp do_fetch(provider) do
    {:error, "No model discovery for provider: #{provider}"}
  end

  defp fetch_from_cli(binary, args, parser) do
    try do
      case System.cmd(binary, args, stderr_to_stdout: true) do
        {output, 0} ->
          parser.(output)

        {output, code} ->
          {:error, "CLI exited with code #{code}: #{String.slice(output, 0, 200)}"}
      end
    rescue
      e -> {:error, Exception.message(e)}
    catch
      _, reason -> {:error, inspect(reason)}
    end
  end

  # --- Cursor model parser ---
  # Parses output of `cursor agent --list-models`:
  #
  # auto - Auto  (current)
  # gpt-5.3-codex - GPT-5.3 Codex
  # composer-2 - Composer 2  (default)
  #
  # Lines: "slug - Display Name" with optional (current)/(default) suffix

  defp parse_cursor_models(output) do
    models =
      output
      |> String.split("\n")
      |> Enum.map(&strip_ansi/1)
      |> Enum.map(&String.trim/1)
      |> Enum.filter(&(&1 =~ ~r/^[a-z0-9][\w.\-]+ - .+/))
      |> Enum.map(fn line ->
        case Regex.run(~r/^([\w.\-]+)\s+-\s+(.+?)(?:\s+\((current|default)\))?$/, line) do
          [_, slug, name | _rest] ->
            %{"slug" => String.trim(slug), "name" => String.trim(name)}

          _ ->
            nil
        end
      end)
      |> Enum.reject(&is_nil/1)

    {:ok, models}
  end

  # --- OpenCode model parser ---
  # Parses output of `opencode models`:
  # One slug per line, format: "provider/model" (e.g., "opencode/big-pickle")
  # Clean output, no ANSI codes.

  # Well-known acronyms that should be uppercased in display names.
  @known_acronyms ~w(gpt glm mimo llm vl moe zai ai)

  defp parse_opencode_models(output) do
    models =
      output
      |> String.split("\n")
      |> Enum.map(&String.trim/1)
      |> Enum.filter(&(&1 =~ ~r/^[\w\-]+\/[\w\-\.]+$/))
      |> Enum.map(fn slug ->
        # Derive a human name from the slug, preserving the provider prefix.
        # "zai-coding-plan/glm-4.5" → "ZAI Coding Plan — GLM 4.5"
        # "opencode/big-pickle"     → "OpenCode — Big Pickle"
        [provider_part | rest] = String.split(slug, "/")
        model_part = Enum.join(rest, "/")

        provider_name = humanize_segment(provider_part)
        model_name = humanize_segment(model_part)

        %{"slug" => slug, "name" => "#{provider_name} — #{model_name}"}
      end)

    {:ok, models}
  end

  defp humanize_segment(segment) do
    segment
    |> String.replace("-", " ")
    |> String.split(" ")
    |> Enum.map(fn word ->
      if String.downcase(word) in @known_acronyms do
        String.upcase(word)
      else
        String.capitalize(word)
      end
    end)
    |> Enum.join(" ")
  end

  # Strip ANSI escape codes from CLI output
  defp strip_ansi(str) do
    Regex.replace(~r/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/, str, "")
  end
end
