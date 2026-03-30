# 001: Wire MCP Management Through the WebSocket API

## Goal

Expose the existing harness-side MCP management capabilities (status, add, connect, disconnect) through the WebSocket API so the frontend can fetch MCP state on panel open and trigger connect/disconnect actions.

## Context

The harness layer (Elixir) already implements MCP management end-to-end:

- `harness_channel.ex` handles `mcp.status`, `mcp.add`, `mcp.connect`, `mcp.disconnect`
- `session_manager.ex` routes to OpenCode sessions via `with_opencode_session/2`
- `opencode_session.ex` makes HTTP calls to the OpenCode provider's `/mcp` endpoints

The Node adapter layer also exists:

- `HarnessClientAdapter.ts` has `mcpStatus`, `mcpAdd`, `mcpConnect`, `mcpDisconnect`
- `HarnessClientManager.ts` pushes to the Phoenix channel

What's missing is the contract → WS routing → service → frontend API chain.

## Files to Modify

- `packages/contracts/src/ws.ts` — add `mcp.status`, `mcp.add`, `mcp.connect`, `mcp.disconnect` to `WS_METHODS`, add input schemas, add to `WebSocketRequestBody` union
- `apps/server/src/provider/Services/ProviderService.ts` — add 4 MCP methods to `ProviderServiceShape`
- `apps/server/src/provider/Layers/ProviderService.ts` — implement the 4 methods delegating to adapter
- `apps/server/src/wsServer.ts` — add 4 switch cases in `routeRequest()` dispatching to `providerService`
- `apps/web/src/wsNativeApi.ts` — add `mcp` namespace with 4 methods

## Files to Read (Implementation References)

- `apps/server/src/provider/Services/HarnessClientAdapter.ts` — interface for adapter shape
- `apps/server/src/provider/Layers/HarnessClientAdapter.ts` — existing adapter implementation (lines ~1386-1466)
- `apps/server/src/provider/Layers/HarnessClientManager.ts` — existing manager methods (lines ~214-237)
- `packages/contracts/src/ws.ts` — existing WS_METHODS enum, `tagRequestBody`, `WebSocketRequest` schema patterns

## Frontend Integration

After the API is wired:

- `ThreadMcpStatusPanel.tsx` — add fetch-on-open using `NativeApi.mcp.status(threadId)`
- `CompactComposerControlsMenu.tsx` — show MCP toggle based on provider `mcpConfig` capability (not just `hasAnyMcpActivity`)
- Consider connect/disconnect action buttons per server row in the panel

## Dependencies

- None (builds on already-committed WIP/mcp-event-pipeline-passive-panel)

## Schema Changes

- New entries in `WS_METHODS` enum (additive)
- New input schemas for 4 methods (additive)
- Expanded `WebSocketRequestBody` union (additive)
- New methods on `ProviderServiceShape` interface

## Risks

- Only OpenCode sessions support MCP management (`with_opencode_session/2`). Other providers will error. Frontend must handle this gracefully (disable buttons, show capability-based UI).
- `mcp.status` response shape from OpenCode is opaque (`Record<string, unknown>`). May need a response schema once we see the actual payload.
