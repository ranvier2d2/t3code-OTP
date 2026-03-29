/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  type ProviderKind,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import {
  Cause,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";

import {
  classifyProviderError,
  type ProviderAdapterError,
  type ProviderServiceError,
  ProviderValidationError,
} from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { McpConfigService, toPersistedMcpConfigRef } from "../Services/McpConfig.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type AdapterPath = "direct" | "harness";

interface SessionTelemetryState {
  readonly provider: ProviderKind;
  readonly adapterPath: AdapterPath;
  readonly startedAtMs: number;
}

interface ResolvedMcpContext {
  readonly serverCount: number;
  readonly sourceCount: number;
  readonly version: string;
  readonly persistedRef?: ReturnType<typeof toPersistedMcpConfigRef>;
}

interface RecoveredSessionResult {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly session: ProviderSession;
}

interface ResolvedSessionRoute {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly threadId: ThreadId;
  readonly isActive: boolean;
  readonly adapterPath: AdapterPath;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly mcpConfigRef?: unknown;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.mcpConfigRef !== undefined ? { mcpConfigRef: extra.mcpConfigRef } : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getAdapterPath(
  provider: ProviderKind,
  capabilities: ProviderAdapterCapabilities,
): AdapterPath {
  switch (provider) {
    case "cursor":
    case "opencode":
      return "harness";
    case "claudeAgent":
      return "direct";
    case "codex":
    default:
      return capabilities.sessionModelSwitch === "restart-session" ? "harness" : "direct";
  }
}

function toResolvedMcpContext(config: {
  readonly version: string;
  readonly sourcePaths: ReadonlyArray<string>;
  readonly servers: ReadonlyArray<unknown>;
}): ResolvedMcpContext {
  return {
    serverCount: config.servers.length,
    sourceCount: config.sourcePaths.length,
    version: config.version,
    persistedRef: toPersistedMcpConfigRef(config as Parameters<typeof toPersistedMcpConfigRef>[0]),
  };
}

function providerFromError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const provider = "provider" in error ? error.provider : undefined;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

// ---------------------------------------------------------------------------
// resume_cursor validation (Task 007 — codex-harness-only cutover)
// ---------------------------------------------------------------------------

/**
 * Validate a resume cursor value loaded from persistence.
 *
 * A valid cursor must be a non-null, non-undefined value. If it is a string,
 * attempt JSON parse to verify it is well-formed JSON. Objects are accepted
 * as-is (they were already deserialized from JSON by the persistence layer).
 *
 * Returns `{ valid: true, cursor }` when the cursor can be forwarded to the
 * adapter's `startSession`, or `{ valid: false, reason }` with a human-readable
 * explanation when it should be discarded (start fresh session).
 */
function validateResumeCursor(
  cursor: unknown,
):
  | { readonly valid: true; readonly cursor: unknown }
  | { readonly valid: false; readonly reason: string } {
  if (cursor === null || cursor === undefined) {
    return { valid: false, reason: "cursor is null or undefined" };
  }
  if (typeof cursor === "string") {
    const trimmed = cursor.trim();
    if (trimmed.length === 0) {
      return { valid: false, reason: "cursor is an empty string" };
    }
    // Verify it parses as JSON
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || parsed === undefined) {
        return { valid: false, reason: "cursor JSON parses to null/undefined" };
      }
      return { valid: true, cursor: parsed };
    } catch (err) {
      return {
        valid: false,
        reason: `cursor string is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (typeof cursor === "object") {
    // Already deserialized object — accept
    return { valid: true, cursor };
  }
  return { valid: false, reason: `unexpected cursor type: ${typeof cursor}` };
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const mcpConfig = yield* Effect.service(McpConfigService);
    const serverSettings = yield* ServerSettingsService;
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessionTelemetryRef = yield* Ref.make(new Map<ThreadId, SessionTelemetryState>());
    const turnTelemetryRef = yield* Ref.make(new Map<ThreadId, SessionTelemetryState>());

    const setSessionTelemetry = (
      threadId: ThreadId,
      session: SessionTelemetryState,
    ): Effect.Effect<void, never, never> =>
      Ref.update(sessionTelemetryRef, (current) => {
        const next = new Map(current);
        next.set(threadId, session);
        return next;
      });

    const takeSessionTelemetry = (
      threadId: ThreadId,
    ): Effect.Effect<SessionTelemetryState | undefined, never, never> =>
      Ref.modify(sessionTelemetryRef, (current) => {
        const next = new Map(current);
        const existing = next.get(threadId);
        next.delete(threadId);
        return [existing, next] as const;
      });

    const setTurnTelemetry = (
      threadId: ThreadId,
      turn: SessionTelemetryState,
    ): Effect.Effect<void, never, never> =>
      Ref.update(turnTelemetryRef, (current) => {
        const next = new Map(current);
        next.set(threadId, turn);
        return next;
      });

    const takeTurnTelemetry = (
      threadId: ThreadId,
    ): Effect.Effect<SessionTelemetryState | undefined, never, never> =>
      Ref.modify(turnTelemetryRef, (current) => {
        const next = new Map(current);
        const existing = next.get(threadId);
        next.delete(threadId);
        return [existing, next] as const;
      });

    const clearTurnTelemetry = (threadId: ThreadId): Effect.Effect<void, never, never> =>
      Ref.update(turnTelemetryRef, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });

    const recordRecoveryTelemetry = (input: {
      readonly operation: string;
      readonly provider?: ProviderKind | string;
      readonly adapterPath?: AdapterPath;
      readonly cause: Cause.Cause<unknown>;
    }): Effect.Effect<void, never, never> => {
      const error = Cause.squash(input.cause);
      const classification = classifyProviderError(error);
      // TODO(provider-recovery): Promote telemetry recoveryStrategy labels into
      // concrete control-flow once ProviderService owns retry / restart policy.

      return analytics.record("provider.recovery.strategy", {
        operation: input.operation,
        provider: input.provider ?? providerFromError(error) ?? "unknown",
        adapterPath: input.adapterPath ?? "unknown",
        errorName:
          error && typeof error === "object" && "_tag" in error && typeof error._tag === "string"
            ? error._tag
            : error instanceof Error
              ? error.name
              : "UnknownError",
        errorCategory: classification.category,
        strategy: classification.recoveryStrategy,
        recoverable: classification.recoverable,
        outcome: "error",
      });
    };

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.succeed(event).pipe(
        Effect.tap((canonicalEvent) =>
          canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: {
        readonly modelSelection?: unknown;
        readonly lastRuntimeEvent?: string;
        readonly lastRuntimeEventAt?: string;
        readonly mcpConfigRef?: unknown;
      },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );
    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* publishRuntimeEvent(event);

        if (event.type === "turn.completed") {
          const turnTelemetry = yield* takeTurnTelemetry(event.threadId);
          const payload =
            event.payload && typeof event.payload === "object"
              ? (event.payload as { state?: unknown })
              : undefined;
          const state = typeof payload?.state === "string" ? payload.state : "completed";

          if (turnTelemetry) {
            yield* analytics.record("provider.turn.duration", {
              provider: turnTelemetry.provider,
              adapterPath: turnTelemetry.adapterPath,
              durationMs: Date.now() - turnTelemetry.startedAtMs,
              interrupted: state === "interrupted" || state === "cancelled",
              state,
            });
          }
        }

        if (event.type === "session.exited") {
          const sessionTelemetry = yield* takeSessionTelemetry(event.threadId);
          yield* clearTurnTelemetry(event.threadId);
          if (sessionTelemetry) {
            yield* analytics.record("provider.session.end", {
              provider: sessionTelemetry.provider,
              adapterPath: sessionTelemetry.adapterPath,
              durationMs: Date.now() - sessionTelemetry.startedAtMs,
              endReason: "provider-event",
            });
          }
        }
      });

    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
    );
    yield* Effect.forkScoped(worker);

    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(
        // Interrupts are expected when an adapter scope closes during stop —
        // swallow them so they don't propagate and crash the process.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause),
        ),
        Effect.forkScoped,
      ),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }): Effect.Effect<RecoveredSessionResult, ProviderServiceError, never> =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.binding.provider);
        const adapterPath = getAdapterPath(adapter.provider, adapter.capabilities);
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find(
            (session) => session.threadId === input.binding.threadId,
          );
          if (existing) {
            yield* upsertSessionBinding(existing, input.binding.threadId);
            yield* setSessionTelemetry(input.binding.threadId, {
              provider: existing.provider,
              adapterPath,
              startedAtMs: Date.now(),
            });
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              strategy: "adopt-existing",
              adapterPath,
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            yield* analytics.record("provider.session.resume", {
              provider: existing.provider,
              adapterPath,
              outcome: "adopt-existing",
              cursorValid: hasResumeCursor,
            });
            return { adapter, session: existing } as const;
          }
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        const cursorValidation = validateResumeCursor(input.binding.resumeCursor);
        if (!cursorValidation.valid) {
          yield* analytics.record("provider.session.resume", {
            provider: input.binding.provider,
            adapterPath,
            outcome: "cursor-invalid",
            cursorValid: false,
            reason: cursorValidation.reason,
          });
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}': resume cursor is invalid — ${cursorValidation.reason}`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
        const recoveryCwd = persistedCwd ?? process.cwd();
        const persistedMcpSnapshot = yield* mcpConfig.getSnapshot(input.binding.threadId);
        const resolvedMcp = persistedMcpSnapshot
          ? persistedMcpSnapshot
          : yield* mcpConfig
              .resolveConfig({
                provider: input.binding.provider,
                cwd: recoveryCwd,
                threadId: input.binding.threadId,
              })
              .pipe(
                Effect.mapError((error) =>
                  toValidationError(
                    `${input.operation}.resolveMcpConfig`,
                    `Failed to resolve MCP config: ${error.detail}`,
                    error,
                  ),
                ),
              );
        yield* mcpConfig.setSnapshot(input.binding.threadId, resolvedMcp);
        const mcpContext = toResolvedMcpContext(resolvedMcp);
        const mcpSupported = adapter.capabilities.mcpConfig !== "none";
        if (mcpContext.serverCount > 0) {
          yield* analytics.record(mcpSupported ? "mcp.config.sent" : "mcp.config.deferred", {
            provider: input.binding.provider,
            adapterPath,
            version: mcpContext.version,
            serverCount: mcpContext.serverCount,
            sourceCount: mcpContext.sourceCount,
            reason: mcpSupported ? undefined : "provider-capability-none",
            phase: persistedMcpSnapshot ? "session-recovery-persisted" : "session-recovery",
          });
        }

        const resumedExit = yield* Effect.exit(
          adapter.startSession({
            threadId: input.binding.threadId,
            provider: input.binding.provider,
            cwd: recoveryCwd,
            ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
            resumeCursor: cursorValidation.cursor,
            runtimeMode: input.binding.runtimeMode ?? "full-access",
          }),
        );
        if (resumedExit._tag === "Failure") {
          yield* recordRecoveryTelemetry({
            operation: `${input.operation}.resume`,
            provider: input.binding.provider,
            adapterPath,
            cause: resumedExit.cause,
          });
          return yield* Effect.failCause(resumedExit.cause);
        }
        const resumed = resumedExit.value;
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        yield* upsertSessionBinding(
          resumed,
          input.binding.threadId,
          mcpSupported && mcpContext.persistedRef
            ? { mcpConfigRef: mcpContext.persistedRef }
            : undefined,
        );
        yield* setSessionTelemetry(input.binding.threadId, {
          provider: resumed.provider,
          adapterPath,
          startedAtMs: Date.now(),
        });
        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          strategy: "resume-thread",
          adapterPath,
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });
        yield* analytics.record("provider.session.resume", {
          provider: resumed.provider,
          adapterPath,
          outcome: "resume-thread",
          cursorValid: hasResumeCursor,
        });
        if (mcpSupported && mcpContext.serverCount > 0) {
          yield* analytics.record("mcp.config.accepted", {
            provider: resumed.provider,
            adapterPath,
            version: mcpContext.version,
            serverCount: mcpContext.serverCount,
            phase: "session-recovery",
          });
        }
        return { adapter, session: resumed } as const;
      });

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }): Effect.Effect<ResolvedSessionRoute, ProviderServiceError, never> =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const adapter = yield* registry.getByProvider(binding.provider);
        const adapterPath = getAdapterPath(adapter.provider, adapter.capabilities);

        const hasRequestedSession = yield* adapter.hasSession(input.threadId);
        if (hasRequestedSession) {
          return { adapter, threadId: input.threadId, isActive: true, adapterPath } as const;
        }

        if (!input.allowRecovery) {
          return { adapter, threadId: input.threadId, isActive: false, adapterPath } as const;
        }

        const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
        return {
          adapter: recovered.adapter,
          threadId: input.threadId,
          isActive: true,
          adapterPath: getAdapterPath(recovered.adapter.provider, recovered.adapter.capabilities),
        } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          threadId,
          provider: parsed.provider ?? "codex",
        };
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            toValidationError(
              "ProviderService.startSession",
              `Failed to load provider settings: ${error.message}`,
              error,
            ),
          ),
        );
        if (!settings.providers[input.provider].enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${input.provider}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const rawResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.provider === input.provider
            ? persistedBinding.resumeCursor
            : undefined);
        const adapter = yield* registry.getByProvider(input.provider);
        const adapterPath = getAdapterPath(adapter.provider, adapter.capabilities);

        let effectiveResumeCursor: unknown | undefined;
        if (rawResumeCursor !== undefined) {
          const validation = validateResumeCursor(rawResumeCursor);
          if (validation.valid) {
            effectiveResumeCursor = validation.cursor;
          } else {
            yield* analytics.record("provider.session.resume", {
              provider: input.provider,
              adapterPath,
              outcome: "cursor-invalid",
              cursorValid: false,
              reason: validation.reason,
            });
            // Discard invalid cursor — start fresh session instead of failing
            effectiveResumeCursor = undefined;
          }
        }

        const effectiveCwd = input.cwd ?? process.cwd();
        const resolvedMcp = yield* mcpConfig
          .resolveConfig({
            provider: input.provider,
            cwd: effectiveCwd,
            threadId,
          })
          .pipe(
            Effect.mapError((error) =>
              toValidationError(
                "ProviderService.startSession.resolveMcpConfig",
                `Failed to resolve MCP config: ${error.detail}`,
                error,
              ),
            ),
          );
        const mcpContext = toResolvedMcpContext(resolvedMcp);
        const mcpSupported = adapter.capabilities.mcpConfig !== "none";
        yield* analytics.record("mcp.config.resolved", {
          provider: input.provider,
          adapterPath,
          version: mcpContext.version,
          serverCount: mcpContext.serverCount,
          sourceCount: mcpContext.sourceCount,
          supported: mcpSupported,
        });
        if (mcpContext.serverCount > 0) {
          yield* analytics.record(mcpSupported ? "mcp.config.sent" : "mcp.config.deferred", {
            provider: input.provider,
            adapterPath,
            version: mcpContext.version,
            serverCount: mcpContext.serverCount,
            sourceCount: mcpContext.sourceCount,
            reason: mcpSupported ? undefined : "provider-capability-none",
            phase: "session-start",
          });
        }
        const session = yield* adapter.startSession({
          ...input,
          cwd: effectiveCwd,
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        });

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, threadId, {
          modelSelection: input.modelSelection,
          ...(mcpSupported && mcpContext.persistedRef
            ? { mcpConfigRef: mcpContext.persistedRef }
            : {}),
        });
        yield* setSessionTelemetry(threadId, {
          provider: session.provider,
          adapterPath,
          startedAtMs: Date.now(),
        });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          adapterPath,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });
        yield* analytics.record("provider.session.start", {
          provider: session.provider,
          adapterPath,
          runtimeMode: input.runtimeMode,
          model: input.modelSelection?.model ?? null,
          hasResumeCursor: session.resumeCursor !== undefined,
        });
        if (mcpSupported && mcpContext.serverCount > 0) {
          yield* analytics.record("mcp.config.accepted", {
            provider: session.provider,
            adapterPath,
            version: mcpContext.version,
            serverCount: mcpContext.serverCount,
            phase: "session-start",
          });
        }

        return session;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        const turnExit = yield* Effect.exit(routed.adapter.sendTurn(input));
        if (turnExit._tag === "Failure") {
          yield* recordRecoveryTelemetry({
            operation: "ProviderService.sendTurn",
            provider: routed.adapter.provider,
            adapterPath: routed.adapterPath,
            cause: turnExit.cause,
          });
          return yield* Effect.failCause(turnExit.cause);
        }
        const turn = turnExit.value;
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        yield* setTurnTelemetry(input.threadId, {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
          startedAtMs: Date.now(),
        });
        yield* analytics.record("provider.turn.sent", {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
          model: input.modelSelection?.model,
          interactionMode: input.interactionMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
        });
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
          decision: input.decision,
        });
      });

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToUserInput",
          schema: ProviderRespondToUserInputInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToUserInput",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* mcpConfig.clearSnapshot(input.threadId);
        yield* directory.remove(input.threadId);
        const sessionTelemetry = yield* takeSessionTelemetry(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
        yield* analytics.record("provider.session.end", {
          provider: routed.adapter.provider,
          adapterPath: sessionTelemetry?.adapterPath ?? routed.adapterPath,
          durationMs: sessionTelemetry ? Date.now() - sessionTelemetry.startedAtMs : null,
          endReason: "explicit",
        });
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        );
        const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
        for (const bindingOption of persistedBindings) {
          const binding = Option.getOrUndefined(bindingOption);
          if (binding) {
            bindingsByThreadId.set(binding.threadId, binding);
          }
        }

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId);
          if (!binding) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
          } = {};
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.rollbackConversation",
          allowRecovery: true,
        });
        const rollbackResult = yield* Effect.exit(
          routed.adapter.rollbackThread(routed.threadId, input.numTurns),
        );
        yield* analytics.record("provider.conversation.rolled_back", {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
          turns: input.numTurns,
        });
        yield* analytics.record("provider.rollback.outcome", {
          provider: routed.adapter.provider,
          adapterPath: routed.adapterPath,
          numTurns: input.numTurns,
          success: rollbackResult._tag === "Success",
        });
        if (rollbackResult._tag === "Failure") {
          yield* recordRecoveryTelemetry({
            operation: "ProviderService.rollbackConversation",
            provider: routed.adapter.provider,
            adapterPath: routed.adapterPath,
            cause: rollbackResult.cause,
          });
          return yield* Effect.failCause(rollbackResult.cause);
        }
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const threadIds = yield* directory.listThreadIds();
        const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        ).pipe(
          Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)),
        );
        yield* Effect.forEach(activeSessions, (session) =>
          upsertSessionBinding(session, session.threadId, {
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: new Date().toISOString(),
          }),
        ).pipe(Effect.asVoid);
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
        yield* Effect.forEach(threadIds, (threadId) =>
          directory.getProvider(threadId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                threadId,
                provider,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
        yield* Effect.forEach(threadIds, (threadId) =>
          Effect.gen(function* () {
            yield* mcpConfig.clearSnapshot(threadId);
            const sessionTelemetry = yield* takeSessionTelemetry(threadId);
            yield* clearTurnTelemetry(threadId);
            if (!sessionTelemetry) return;
            yield* analytics.record("provider.session.end", {
              provider: sessionTelemetry.provider,
              adapterPath: sessionTelemetry.adapterPath,
              durationMs: Date.now() - sessionTelemetry.startedAtMs,
              endReason: "stop-all",
            });
          }),
        ).pipe(Effect.asVoid);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: threadIds.length,
        });
        yield* analytics.flush;
      });

    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getCapabilities,
      rollbackConversation,
      // Each access creates a fresh PubSub subscription so that multiple
      // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
      // independently receive all runtime events.
      get streamEvents(): ProviderServiceShape["streamEvents"] {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
