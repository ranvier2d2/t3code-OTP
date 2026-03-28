defmodule Harness.MixProject do
  use Mix.Project

  @doc """
  Define the Mix project configuration for the Harness application.
  
  The returned keyword list includes the project's metadata and build configuration:
    - `:app` — atom identifying the OTP application.
    - `:version` — project version string.
    - `:elixir` — required Elixir version requirement.
    - `:elixirc_paths` — source paths selected by environment.
    - `:start_permanent` — whether to start the application in permanent mode in production.
    - `:aliases` — Mix task aliases.
    - `:deps` — dependency specifications.
    - `:releases` — release configuration for building releases.
  """
  @spec project() :: Keyword.t()
  def project do
    [
      app: :harness,
      version: "0.1.0",
      elixir: "~> 1.15",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps(),
      releases: releases()
    ]
  end

  defp releases do
    [
      harness: [
        include_erts: true,
        strip_beams: true,
        cookie: "t3code_harness_desktop_local"
      ]
    ]
  end

  def application do
    [
      mod: {Harness.Application, []},
      extra_applications: [:logger, :runtime_tools, :inets, :ssl]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:phoenix, "~> 1.8"},
      {:jason, "~> 1.4"},
      {:bandit, "~> 1.5"},
      {:req, "~> 0.5"},
      {:exqlite, "~> 0.27"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get"],
      precommit: ["format --check-formatted", "credo", "compile --warnings-as-errors"]
    ]
  end
end
