defmodule Harness.Snapshot do
  @moduledoc """
  In-memory projection of all active harness sessions.
  """

  defstruct sequence: 0,
            updated_at: nil,
            sessions: %{}

  @type t :: %__MODULE__{
          sequence: non_neg_integer(),
          updated_at: String.t() | nil,
          sessions: %{String.t() => Harness.Snapshot.Session.t()}
        }
end

defmodule Harness.Snapshot.Session do
  @moduledoc """
  Projected state of a single provider session.
  """

  defstruct [
    :thread_id,
    :provider,
    :status,
    :model,
    :cwd,
    :runtime_mode,
    :active_turn,
    :created_at,
    :updated_at,
    pending_requests: %{}
  ]

  @type t :: %__MODULE__{
          thread_id: String.t(),
          provider: String.t(),
          status: :connecting | :ready | :running | :error | :closed,
          model: String.t() | nil,
          cwd: String.t() | nil,
          runtime_mode: :approval_required | :full_access | nil,
          active_turn: map() | nil,
          pending_requests: %{String.t() => map()},
          created_at: String.t() | nil,
          updated_at: String.t() | nil
        }
end
