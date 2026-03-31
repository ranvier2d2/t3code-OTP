defmodule Harness.Providers.ProviderBehaviour do
  @moduledoc """
  Behaviour contract for harness provider session modules.

  Defines the callbacks that every provider session GenServer must implement
  to be routable through SessionManager. This ensures consistent public APIs
  across CodexSession, AcpSession, OpenCodeSession, and ClaudeSession.

  ## Required callbacks

  - `start_link/1` - Start a provider session GenServer.
  - `wait_for_ready/2` - Block until the provider startup handshake is ready for SessionManager dispatch.
  - `send_turn/2` - Send a conversational turn to the provider.
  - `interrupt_turn/3` - Interrupt an active turn.
  - `respond_to_approval/3` - Respond to an approval request.
  - `respond_to_user_input/3` - Respond to a user input request.
  - `read_thread/2` - Read the current thread snapshot.
  - `rollback_thread/3` - Roll back the thread by N turns.
  - `stop/1` - Optional provider-local shutdown helper; SessionManager shutdowns are handled by the supervisor rather than dispatching `stop/1`.

  ## Usage

      defmodule Harness.Providers.MySession do
        @behaviour Harness.Providers.ProviderBehaviour
        use GenServer, restart: :temporary

        @impl Harness.Providers.ProviderBehaviour
        def start_link(opts), do: ...

        # ... implement all callbacks
      end
  """

  @doc """
  Start a provider session GenServer.

  Opts map contains at minimum:
  - `:thread_id` - Unique thread identifier
  - `:provider` - Provider kind string
  - `:params` - Session start parameters (cwd, model, mcp_config, etc.)
  - `:event_callback` - Function to call with provider events
  """
  @callback start_link(opts :: map()) :: GenServer.on_start()

  @doc """
  Wait for the provider session to become ready.

  Called by SessionManager after `start_link/1` so providers can block until
  CLI bootstrap, handshake, or auth readiness is complete.
  """
  @callback wait_for_ready(pid :: pid(), timeout :: timeout()) :: :ok | {:error, term()}

  @doc """
  Send a conversational turn to the provider.
  """
  @callback send_turn(pid :: pid(), params :: map()) :: {:ok, map()} | {:error, term()}

  @doc """
  Interrupt an active turn.
  """
  @callback interrupt_turn(pid :: pid(), thread_id :: String.t(), turn_id :: String.t() | nil) ::
              :ok | {:error, term()}

  @doc """
  Respond to an approval request (file change, command execution, etc.).
  """
  @callback respond_to_approval(pid :: pid(), request_id :: String.t(), decision :: String.t()) ::
              :ok | {:error, term()}

  @doc """
  Respond to a structured user input request.
  """
  @callback respond_to_user_input(pid :: pid(), request_id :: String.t(), answers :: map()) ::
              :ok | {:error, term()}

  @doc """
  Read the current thread snapshot (turns and items).
  """
  @callback read_thread(pid :: pid(), thread_id :: String.t()) :: {:ok, map()} | {:error, term()}

  @doc """
  Roll back the thread by N turns.
  """
  @callback rollback_thread(pid :: pid(), thread_id :: String.t(), num_turns :: non_neg_integer()) ::
              {:ok, map()} | {:error, term()}

  @doc """
  Set a session configuration option (e.g., model, mode).

  Optional callback. Providers that don't support mid-session config changes
  return `{:error, :not_supported}`.
  """
  @callback set_config(pid :: pid(), config_id :: String.t(), value :: String.t()) ::
              {:ok, map()} | {:error, term()}

  @optional_callbacks [set_config: 3]

  @doc """
  Stop the session if the provider module exposes an explicit shutdown helper.

  SessionManager does not dispatch `stop/1`; normal shutdown is handled by the
  supervisor tree. Implement this only when the provider needs an explicit
  escape hatch for manual cleanup paths.
  """
  @callback stop(pid :: pid()) :: :ok | {:error, term()}
end
