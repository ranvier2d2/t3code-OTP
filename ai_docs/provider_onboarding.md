# Provider Onboarding Playbook

Guide for adding a new coding agent provider to T3 Code.

## Architecture Overview

T3 Code uses a layered adapter architecture:

```text
Transport (WebSocket/RPC)
    |
ProviderService (cross-provider facade)
    |
ProviderAdapterRegistry (adapter lookup)
    |
ProviderAdapter (provider-specific runtime)
    |
Provider CLI/SDK (codex, claude, cursor, opencode, ...)
```

**Two runtime paths**:

- **Node SDK adapters** (ClaudeAdapter, CodexAdapter) -- run in-process via JS/TS SDKs
- **Harness adapters** (HarnessClientAdapter) -- bridge to Elixir GenServer sessions via WebSocket

Most new providers will use the **harness path** (Elixir GenServer) unless they have a first-class Node.js SDK.

## Step 1: Declare Provider Kind

Add the new provider to the `ProviderKind` schema in `packages/contracts/src/orchestration.ts`:

```typescript
export const ProviderKind = Schema.Literal(
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "YOUR_PROVIDER",
);
```

## Step 2: Choose Runtime Path

### Path A: Elixir Harness (recommended for CLI-based providers)

1. **Create session module**: `apps/harness/lib/harness/providers/your_session.ex`
   - Implement `@behaviour Harness.Providers.ProviderBehaviour`
   - Implement the SessionManager-facing callbacks: `start_link/1`, `wait_for_ready/2`, `send_turn/2`, `interrupt_turn/3`, `respond_to_approval/3`, `respond_to_user_input/3`, `read_thread/2`, and `rollback_thread/3`
   - If your module exposes `stop/1`, document it as a provider-owned shutdown helper; supervisor shutdown is not dispatched through SessionManager
   - Use `GenServer, restart: :temporary`
   - Register via `{:via, Registry, {Harness.SessionRegistry, thread_id, "your_provider"}}`

2. **Register in SessionManager**: `apps/harness/lib/harness/session_manager.ex`
   - Add clause to `provider_module/1`: `defp provider_module("your_provider"), do: {:ok, YourSession}`

3. **Declare capabilities**: Add entry in `HARNESS_PROVIDER_CAPABILITIES` in `apps/server/src/provider/Layers/HarnessClientAdapter.ts`

4. **Register in serverLayers.ts**: Add the provider to the `HARNESS_PROVIDERS` array in `makeServerProviderLayer()`

### Path B: Node SDK Adapter (for providers with JS/TS SDKs)

1. **Create service tag**: `apps/server/src/provider/Services/YourAdapter.ts`
   - Follow `ClaudeAdapter.ts` pattern
   - Extend `ProviderAdapterShape<ProviderAdapterError>`

2. **Create layer**: `apps/server/src/provider/Layers/YourAdapter.ts`
   - Implement all methods of `ProviderAdapterShape`
   - Include `translateMcpConfig` (return null if provider manages its own MCP)

3. **Register in adapter registry**: Update `ProviderAdapterRegistryLive` or `makeServerProviderLayer()`

## Step 3: Implement ProviderAdapterShape Methods

Every adapter must implement these methods (see `apps/server/src/provider/Services/ProviderAdapter.ts`):

| Method               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `startSession`       | Start a provider-backed session                |
| `sendTurn`           | Send a conversational turn                     |
| `interruptTurn`      | Interrupt an active turn                       |
| `respondToRequest`   | Respond to approval requests                   |
| `respondToUserInput` | Respond to user input requests                 |
| `stopSession`        | Stop one session                               |
| `listSessions`       | List active sessions                           |
| `hasSession`         | Check session ownership                        |
| `readThread`         | Read thread snapshot                           |
| `rollbackThread`     | Roll back N turns                              |
| `stopAll`            | Stop all sessions                              |
| `translateMcpConfig` | Translate MCP config to provider-native format |

## Step 4: Declare Capabilities

Set `ProviderAdapterCapabilities` for your provider. In shared contracts this shape is represented by `ProviderCapabilities`, and the capability level fields use `ProviderCapabilityLevel`:

```typescript
{
  sessionModelSwitch: "in-session" | "restart-session" | "unsupported",
  supportsUserInput: boolean,
  supportsRollback: boolean,
  supportsFileChangeApproval: boolean,
  resume: "none" | "basic" | "full",
  subagents: "none" | "basic" | "full",
  attachments: "none" | "basic" | "full",
  replay: "none" | "basic" | "full",
  mcpConfig: "none" | "basic" | "full",
}
```

The contract test suite (`apps/server/integration/contract.integration.test.ts`) uses these to auto-skip tests for unsupported capabilities.

## Step 5: Runtime Event Mapping

Your adapter must emit `ProviderRuntimeEvent` objects with these core event types:

- `turn.started` / `turn.completed` -- turn lifecycle
- `content.delta` -- streaming text output
- `item.started` / `item.completed` -- tool/file-change items
- `request.opened` / `request.resolved` -- approval flow
- `session.status` -- session state changes

See `packages/contracts/src/providerRuntime.ts` for the full event schema.

## Step 6: MCP Configuration

If your provider supports external MCP servers:

- Implement `translateMcpConfig()` to convert `ResolvedMcpConfig` to provider-native format
- The harness path stores `mcp_config` in the session state (see `codex_session.ex`)

If your provider manages its own MCP (like Claude):

- Return `null` from `translateMcpConfig()`

## Step 7: Settings Integration

Add provider entry in `packages/contracts/src/settings.ts` server settings schema so users can enable/disable and configure the provider.

## Step 8: Testing

1. **Unit tests**: Add adapter-level tests in `apps/server/src/provider/Layers/YourAdapter.test.ts`
2. **Contract tests**: The contract suite auto-includes all registered providers
3. **Integration tests**: Add provider-specific integration scenarios if needed

## Step 9: Model Discovery (Optional)

If your provider supports model listing:

- Elixir: implement model discovery in the session module or a separate GenServer
- Node: expose via the adapter shape

Register in `ProviderRegistry` (`apps/server/src/provider/Services/ProviderRegistry.ts`) for the UI model picker.

## Checklist

- [ ] Provider kind added to `ProviderKind` schema
- [ ] Session module created (Elixir) or adapter layer created (Node)
- [ ] `@behaviour ProviderBehaviour` implemented (Elixir path)
- [ ] Capabilities declared
- [ ] Runtime event mapping implemented
- [ ] MCP config translator implemented
- [ ] Registered in SessionManager (Elixir) or adapter registry (Node)
- [ ] Settings entry added
- [ ] Unit tests passing
- [ ] Contract tests passing (or properly skipping unsupported capabilities)
