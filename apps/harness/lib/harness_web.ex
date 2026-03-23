defmodule HarnessWeb do
  @moduledoc false

  def channel do
    quote do
      use Phoenix.Channel, log_handle_in: false
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
