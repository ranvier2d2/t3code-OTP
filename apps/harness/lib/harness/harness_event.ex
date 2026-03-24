defmodule Harness.Event do
  @moduledoc """
  Harness event structure. Wraps raw provider events with routing metadata.
  """

  defstruct [
    :event_id,
    :thread_id,
    :provider,
    :created_at,
    :kind,
    :method,
    :payload
  ]

  @type t :: %__MODULE__{
          event_id: String.t(),
          thread_id: String.t(),
          provider: String.t(),
          created_at: String.t(),
          kind: :session | :notification | :request | :error,
          method: String.t(),
          payload: map() | nil
        }

  @doc """
  Create a new harness event from a raw provider event.
  """
  def new(attrs) do
    %__MODULE__{
      event_id: Map.get(attrs, :event_id, generate_id()),
      thread_id: Map.fetch!(attrs, :thread_id),
      provider: Map.fetch!(attrs, :provider),
      created_at: Map.get(attrs, :created_at, now_iso()),
      kind: Map.fetch!(attrs, :kind),
      method: Map.fetch!(attrs, :method),
      payload: Map.get(attrs, :payload)
    }
  end

  defp generate_id do
    Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end

  defp now_iso do
    DateTime.utc_now() |> DateTime.to_iso8601()
  end
end
