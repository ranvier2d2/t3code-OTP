defmodule Harness.ProviderSession do
  @moduledoc """
  Behaviour implemented by provider-backed session processes.

  `Harness.SessionManager` dispatches to this surface regardless of whether the
  provider uses a persistent stdio process, a turn-scoped CLI, or an HTTP/SSE
  bridge.
  """

  @type request_id :: term()
  @type decision :: term()
  @type answers :: term()
  @type params :: map()
  @type thread_id :: String.t()
  @type turn_id :: term()
  @type snapshot :: term()

  @callback start_link(keyword() | map()) :: GenServer.on_start()
  @callback wait_for_ready(GenServer.server(), timeout()) :: :ok | {:error, term()}
  @callback send_turn(GenServer.server(), params()) :: term()
  @callback interrupt_turn(GenServer.server(), thread_id(), turn_id() | nil) :: term()
  @callback respond_to_approval(GenServer.server(), request_id(), decision()) :: term()
  @callback respond_to_user_input(GenServer.server(), request_id(), answers()) :: term()
  @callback read_thread(GenServer.server(), thread_id()) :: {:ok, snapshot()} | {:error, term()}
  @callback rollback_thread(GenServer.server(), thread_id(), non_neg_integer()) ::
              {:ok, snapshot()} | {:error, term()}
end
