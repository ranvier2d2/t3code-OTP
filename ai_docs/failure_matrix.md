# Provider Failure Matrix

Populated failure matrix mapping operations, providers, error types, and recovery behavior.

## Error Categories

| Category        | Description                             | Recovery Strategy                      |
| --------------- | --------------------------------------- | -------------------------------------- |
| `transient`     | Temporary failure, may succeed on retry | Retry with exponential backoff (max 3) |
| `permanent`     | Unrecoverable error                     | Fail immediately, surface to user      |
| `configuration` | Misconfigured provider/environment      | Re-resolve config, prompt user to fix  |
| `unavailable`   | Provider is down or unreachable         | Degrade gracefully, suggest fallback   |

## Failure Matrix

| Operation              | Provider           | Error Class                           | Category        | Current Behavior                       | Desired Behavior                       |
| ---------------------- | ------------------ | ------------------------------------- | --------------- | -------------------------------------- | -------------------------------------- |
| `startSession`         | codex (harness)    | `ProviderAdapterProcessError`         | `configuration` | Error propagated to transport          | Check binary exists before spawn       |
| `startSession`         | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Retry spawn with backoff               |
| `startSession`         | claudeAgent        | `ProviderAdapterProcessError`         | `configuration` | Error propagated to transport          | Validate API key before spawn          |
| `startSession`         | claudeAgent        | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Retry with backoff                     |
| `startSession`         | cursor (harness)   | `ProviderAdapterProcessError`         | `configuration` | Error propagated to transport          | Check cursor binary path               |
| `startSession`         | opencode (harness) | `ProviderAdapterProcessError`         | `configuration` | Error propagated to transport          | Check opencode binary path             |
| `startSession`         | any                | `ProviderValidationError`             | `permanent`     | Error propagated to transport          | Correct (no change needed)             |
| `startSession`         | any                | `ProviderUnsupportedError`            | `configuration` | Error propagated to transport          | Suggest enabling provider in settings  |
| `sendTurn`             | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Auto-retry once, then surface          |
| `sendTurn`             | codex (harness)    | `ProviderAdapterSessionNotFoundError` | `permanent`     | Recovery via `recoverSessionForThread` | Correct (recovery already implemented) |
| `sendTurn`             | claudeAgent        | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Auto-retry once, then surface          |
| `sendTurn`             | claudeAgent        | `ProviderAdapterSessionClosedError`   | `permanent`     | Error propagated to transport          | Prompt user to start new session       |
| `sendTurn`             | any                | `ProviderValidationError`             | `permanent`     | Error propagated to transport          | Correct (validation is permanent)      |
| `interruptTurn`        | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Best-effort interrupt, log failure     |
| `interruptTurn`        | claudeAgent        | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Best-effort interrupt, log failure     |
| `respondToRequest`     | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Retry once for approval responses      |
| `respondToRequest`     | claudeAgent        | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Retry once for approval responses      |
| `stopSession`          | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Force-stop on timeout                  |
| `stopSession`          | claudeAgent        | `ProviderAdapterProcessError`         | `unavailable`   | Error propagated to transport          | Kill process, mark session closed      |
| `rollbackConversation` | codex (harness)    | `ProviderAdapterRequestError`         | `transient`     | Recovery via resume + rollback         | Correct (already recovers)             |
| `rollbackConversation` | claudeAgent        | `ProviderAdapterRequestError`         | `transient`     | Error propagated to transport          | Resume session first, then rollback    |
| `listSessions`         | any                | (no errors expected)                  | -               | Returns empty on failure               | Correct                                |
| `getCapabilities`      | any                | `ProviderUnsupportedError`            | `configuration` | Error propagated to transport          | Return empty capabilities for unknown  |

## Error Classification by `_tag`

| Error `_tag`                               | Default Category | Notes                                                                               |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| `ProviderAdapterRequestError`              | `transient`      | Promoted to `permanent` if detail contains "not found", "unauthorized", "forbidden" |
| `ProviderAdapterProcessError`              | `transient`      | Promoted to `configuration` if ENOENT/permission; `unavailable` if crashed/signal   |
| `ProviderAdapterValidationError`           | `permanent`      | Invalid input to adapter API                                                        |
| `ProviderAdapterSessionNotFoundError`      | `permanent`      | Session ID does not exist                                                           |
| `ProviderAdapterSessionClosedError`        | `permanent`      | Session exists but is closed                                                        |
| `ProviderValidationError`                  | `permanent`      | Invalid input to ProviderService API                                                |
| `ProviderUnsupportedError`                 | `configuration`  | Provider not registered                                                             |
| `ProviderSessionNotFoundError`             | `permanent`      | Thread not found in session directory                                               |
| `ProviderSessionDirectoryPersistenceError` | `transient`      | SQLite/persistence layer failure                                                    |
