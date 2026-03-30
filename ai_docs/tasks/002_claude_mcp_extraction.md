# 002: Extract Claude CLI MCP Server Info from system/init

## Goal

Parse the `mcp_servers` array from Claude CLI's `system/init` message and emit `mcp.status.updated` events per server, so the MCP status panel works for Claude sessions (not just Codex/OpenCode).

## Context

Claude CLI sends a `system/init` message with rich metadata including:

```typescript
mcp_servers: {
  name: string;
  status: string;
}
[];
```

Currently `claude_session.ex` `handle_system_message/2` only extracts `session_id`, `model`, and `cwd`. The `mcp_servers` field is ignored.

Claude also supports control messages for MCP management:

- `mcp_status` — get current MCP server statuses
- `mcp_reconnect` — reconnect a specific MCP server
- `mcp_toggle` — enable/disable a specific MCP server

These are sent as input to the Claude CLI process, not extracted from output.

## Files to Modify

- `apps/harness/lib/harness/providers/claude_session.ex` — extract `mcp_servers` from `system/init`, emit events per server

## Files to Read (Implementation References)

- `apps/harness/lib/harness/providers/claude_session.ex` — current `handle_system_message` (lines ~599-610)
- `apps/harness/lib/harness/providers/codex_session.ex` — reference for event emission patterns
- `apps/server/src/provider/Layers/codexEventMapping.ts` — how `mcp.status.updated` events are mapped (to confirm payload shape)
- `packages/contracts/src/providerRuntime.ts` — `McpStatusUpdatedPayload` schema (`{ server: string, status: Unknown }`)

## Implementation

In `handle_system_message(%{"subtype" => "init"} = msg, state)`:

1. Extract `mcp_servers` list: `mcp_servers = Map.get(msg, "mcp_servers", [])`
2. For each server in the list, emit an event:
   ```elixir
   Enum.each(mcp_servers, fn server ->
     emit_event(state, :notification, "mcpServer/startupStatus/updated", %{
       "name" => server["name"],
       "status" => server["status"]
     })
   end)
   ```
3. The existing `codexEventMapping.ts` already maps `mcpServer/startupStatus/updated` → `mcp.status.updated`, so no server-side changes needed.

## Optional: Cursor Session

`cursor_session.ex` also receives `system/init` — if Cursor's CLI sends `mcp_servers` too, apply the same extraction there. Check the actual message shape first.

## Dependencies

- None (builds on already-committed WIP/mcp-event-pipeline-passive-panel which has the event mapping pipeline)

## Schema Changes

- None (reuses existing `mcpServer/startupStatus/updated` event method and `mcp.status.updated` mapping)

## Risks

- Claude CLI's `mcp_servers[].status` values may differ from Codex's status values (e.g., `"connected"` vs `"ready"`). Need to verify and potentially normalize in `codexEventMapping.ts` or add a claude-specific mapper.
- If Claude session is not yet spawned when the panel opens, there will be no events. This is acceptable for now (the panel already handles "no MCP activity" gracefully).
