defmodule HarnessWeb.HarnessSocket do
  use Phoenix.Socket

  channel "harness:*", HarnessWeb.HarnessChannel

  @impl true
  def connect(params, socket, _connect_info) do
    expected_secret = Application.get_env(:harness, :harness_secret) || ""
    secret = Map.get(params, "secret", "")

    if is_binary(secret) and byte_size(secret) > 0 and byte_size(expected_secret) > 0 and
         Plug.Crypto.secure_compare(secret, expected_secret) do
      {:ok, socket}
    else
      :error
    end
  end

  @impl true
  def id(_socket), do: nil
end
