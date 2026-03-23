defmodule HarnessWeb.HarnessSocket do
  use Phoenix.Socket

  channel "harness:*", HarnessWeb.HarnessChannel

  @impl true
  def connect(params, socket, _connect_info) do
    expected_secret = Application.get_env(:harness, :harness_secret, "dev-harness-secret")

    case Map.get(params, "secret") do
      ^expected_secret ->
        {:ok, socket}

      _other ->
        :error
    end
  end

  @impl true
  def id(_socket), do: nil
end
