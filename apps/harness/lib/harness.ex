defmodule Harness do
  @moduledoc """
  HarnessService — centralized provider connection hub.

  Manages WebSocket/stdio/SSE connections to AI providers (Codex, Claude, OpenCode)
  via OTP supervision. Projects harness events into an in-memory HarnessSnapshot.
  Exposes a Phoenix Channel API for Node to control sessions and receive events.
  """
end
