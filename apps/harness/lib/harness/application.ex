defmodule Harness.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    # Ensure inets + ssl are started for :httpc (used by OpenCodeSession)
    {:ok, _} = Application.ensure_all_started(:inets)
    {:ok, _} = Application.ensure_all_started(:ssl)

    children = [
      {Phoenix.PubSub, name: Harness.PubSub},
      {Registry, keys: :unique, name: Harness.SessionRegistry},
      {DynamicSupervisor, name: Harness.SessionSupervisor, strategy: :one_for_one},
      Harness.Storage,
      Harness.SnapshotServer,
      HarnessWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: Harness.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    HarnessWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
