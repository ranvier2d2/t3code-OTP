defmodule Harness.MixProject do
  use Mix.Project

  def project do
    [
      app: :harness,
      version: "0.1.0",
      elixir: "~> 1.15",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps()
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
