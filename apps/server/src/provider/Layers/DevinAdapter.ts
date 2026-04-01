import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  EventId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import { Cause, Effect, Fiber, Layer, Queue, Result, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors";
import { createDevinApiClient, DevinApiError, type DevinSessionMessage } from "../devinApi";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter";

const PROVIDER = "devin" as const;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_POLL = 5;
const MAX_SEEN_MESSAGE_EVENT_IDS = 256;

type DevinResumeCursor = {
  readonly orgId: string;
  readonly devinId: string | null;
  readonly lastMessageCursor?: string | null;
  readonly lastMessageEventId?: string | null;
};

interface DevinRemoteBinding {
  readonly orgId: string;
  readonly devinId: string;
  readonly sessionUrl: string | null;
}

interface DevinTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface DevinSessionContext {
  session: ProviderSession;
  remote: DevinRemoteBinding | null;
  activeTurnId: TurnId | null;
  turns: Array<DevinTurnSnapshot>;
  pollFiber: Fiber.Fiber<void, unknown> | null;
  lastMessageCursor: string | null;
  lastMessageEventId: string | null;
  seenMessageEventIds: RecentEventIdCache;
  lastRemoteStatus: string | null;
  lastRemoteStatusDetail: string | null;
  stopped: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent<T extends ProviderRuntimeEvent["type"]>(
  type: T,
  payload: Extract<ProviderRuntimeEvent, { type: T }>["payload"],
  input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | null;
    readonly itemId?: string | null;
  },
): ProviderRuntimeEvent {
  return {
    type,
    eventId: EventId.makeUnsafe(`${PROVIDER}-${randomUUID()}`),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    payload,
  } as ProviderRuntimeEvent;
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

class RecentEventIdCache {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(value: string): boolean {
    return this.seen.has(value);
  }

  add(value: string): void {
    if (this.seen.has(value)) {
      return;
    }
    this.seen.add(value);
    this.order.push(value);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted) {
        this.seen.delete(evicted);
      }
    }
  }
}

function parseResumeCursor(value: unknown): DevinResumeCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const orgId = trimOrNull(record.orgId);
  if (!orgId) {
    return null;
  }
  return {
    orgId,
    devinId: trimOrNull(record.devinId),
    lastMessageCursor: trimOrNull(record.lastMessageCursor),
    lastMessageEventId: trimOrNull(record.lastMessageEventId),
  };
}

function makeResumeCursor(input: {
  readonly orgId: string;
  readonly remote: DevinRemoteBinding | null;
  readonly lastMessageCursor: string | null;
  readonly lastMessageEventId: string | null;
}): DevinResumeCursor {
  return {
    orgId: input.orgId,
    devinId: input.remote?.devinId ?? null,
    lastMessageCursor: input.lastMessageCursor,
    lastMessageEventId: input.lastMessageEventId,
  };
}

function makeTurnId(threadId: ThreadId): TurnId {
  return TurnId.makeUnsafe(`devin-turn-${String(threadId)}-${randomUUID()}`);
}

function turnStateFromRemoteStatus(
  status: string | null,
  statusDetail: string | null,
): Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"]["state"] {
  if (status === "error" || statusDetail === "error") {
    return "failed";
  }
  return "completed";
}

function sessionStateFromRemote(
  status: string | null,
  statusDetail: string | null,
): Extract<ProviderRuntimeEvent, { type: "session.state.changed" }>["payload"]["state"] {
  if (status === "error") {
    return "error";
  }
  if (status === "exit") {
    return "stopped";
  }
  if (status === "running" && statusDetail === "working") {
    return "running";
  }
  if (
    status === "suspended" ||
    statusDetail === "waiting_for_user" ||
    statusDetail === "waiting_for_approval"
  ) {
    return "waiting";
  }
  if (status === "new" || status === "creating" || status === "claimed" || status === "resuming") {
    return "starting";
  }
  return "ready";
}

function pollIntervalMs(status: string | null, statusDetail: string | null): number | null {
  if (status === "exit" || status === "error") {
    return null;
  }
  if (
    status === "suspended" ||
    statusDetail === "waiting_for_user" ||
    statusDetail === "waiting_for_approval"
  ) {
    return 10_000;
  }
  return 5_000;
}

function runtimeWarningMessage(statusDetail: string | null): string | null {
  switch (statusDetail) {
    case "waiting_for_user":
      return "Devin is waiting for user input in the Devin UI.";
    case "waiting_for_approval":
      return "Devin is waiting for approval in the Devin UI.";
    case "inactivity":
      return "Devin session is suspended due to inactivity.";
    case "user_request":
      return "Devin session is suspended pending user action.";
    case "usage_limit_exceeded":
    case "out_of_credits":
    case "out_of_quota":
    case "no_quota_allocation":
    case "payment_declined":
    case "org_usage_limit_exceeded":
      return `Devin session is blocked by billing or quota state: ${statusDetail}.`;
    default:
      return null;
  }
}

function toRequestError(
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toApiDetail(error: unknown): string {
  if (error instanceof DevinApiError) {
    return error.status ? `${error.message} (${error.status})` : error.message;
  }
  return error instanceof Error ? error.message : "Unknown Devin API failure.";
}

export const DevinAdapterLive = Layer.effect(
  DevinAdapter,
  Effect.gen(function* () {
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const directory = yield* ProviderSessionDirectory;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const sessions = new Map<ThreadId, DevinSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const getApiClient = (): Effect.Effect<
      { readonly client: ReturnType<typeof createDevinApiClient>; readonly orgId: string },
      ProviderAdapterValidationError
    > =>
      serverSettings.getSettings.pipe(
        Effect.mapError((error) => toValidationError("DevinAdapter.config", error.message, error)),
        Effect.flatMap((settings) => {
          const providerSettings = settings.providers?.devin;
          if (!providerSettings) {
            return Effect.fail(
              toValidationError("DevinAdapter.config", "Devin provider settings are missing."),
            );
          }
          const orgId =
            trimOrNull(process.env.T3CODE_DEVIN_ORG_ID) ??
            trimOrNull(process.env.DEVIN_ORG_ID) ??
            trimOrNull(providerSettings.orgId);
          const apiKey =
            trimOrNull(process.env.T3CODE_DEVIN_API_KEY) ?? trimOrNull(process.env.DEVIN_API_KEY);
          if (!orgId) {
            return Effect.fail(
              toValidationError("DevinAdapter.config", "Devin org ID is not configured."),
            );
          }
          if (!apiKey) {
            return Effect.fail(
              toValidationError(
                "DevinAdapter.config",
                "Devin API key is not configured. Set T3CODE_DEVIN_API_KEY or DEVIN_API_KEY and try again.",
              ),
            );
          }
          return Effect.succeed({
            client: createDevinApiClient({
              baseUrl: providerSettings.baseUrl,
              apiKey,
            }),
            orgId,
          });
        }),
      );

    const persistBinding = (threadId: ThreadId, context: DevinSessionContext) =>
      directory
        .upsert({
          threadId,
          provider: PROVIDER,
          status:
            context.session.status === "error"
              ? "error"
              : context.session.status === "closed"
                ? "stopped"
                : "running",
          resumeCursor: makeResumeCursor({
            orgId:
              context.remote?.orgId ?? parseResumeCursor(context.session.resumeCursor)?.orgId ?? "",
            remote: context.remote,
            lastMessageCursor: context.lastMessageCursor,
            lastMessageEventId: context.lastMessageEventId,
          }),
          runtimePayload: {
            cwd: context.session.cwd ?? null,
            model: context.session.model ?? null,
            activeTurnId: context.activeTurnId ?? null,
            lastStatus: context.lastRemoteStatus,
            lastStatusDetail: context.lastRemoteStatusDetail,
            orgId:
              context.remote?.orgId ??
              parseResumeCursor(context.session.resumeCursor)?.orgId ??
              null,
            devinId: context.remote?.devinId ?? null,
            sessionUrl: context.remote?.sessionUrl ?? null,
            lastMessageCursor: context.lastMessageCursor,
            lastMessageEventId: context.lastMessageEventId,
          },
        })
        .pipe(Effect.ignore({ log: true }));

    const completeActiveTurn = (
      context: DevinSessionContext,
      status: string | null,
      statusDetail: string | null,
    ) =>
      Effect.gen(function* () {
        if (!context.activeTurnId) {
          return;
        }
        const turnId = context.activeTurnId;
        context.activeTurnId = null;
        context.session = {
          ...context.session,
          activeTurnId: undefined,
          status: "ready",
          updatedAt: nowIso(),
        };
        yield* emit(
          makeEvent(
            "turn.completed",
            {
              state: turnStateFromRemoteStatus(status, statusDetail),
              stopReason: statusDetail,
            },
            { threadId: context.session.threadId, turnId },
          ),
        );
      });

    const emitMessageEvents = (context: DevinSessionContext, message: DevinSessionMessage) =>
      Effect.gen(function* () {
        if (message.source !== "devin" || context.seenMessageEventIds.has(message.eventId)) {
          return;
        }
        context.seenMessageEventIds.add(message.eventId);
        context.lastMessageEventId = message.eventId;
        const turnId = context.activeTurnId;
        const itemId = `devin-msg-${message.eventId}`;
        yield* emit(
          makeEvent(
            "item.started",
            {
              itemType: "assistant_message",
              title: "Devin response",
            },
            { threadId: context.session.threadId, turnId, itemId },
          ),
        );
        yield* emit(
          makeEvent(
            "content.delta",
            {
              streamKind: "assistant_text",
              delta: message.message,
            },
            { threadId: context.session.threadId, turnId, itemId },
          ),
        );
        yield* emit(
          makeEvent(
            "item.completed",
            {
              itemType: "assistant_message",
              status: "completed",
              title: "Devin response",
            },
            { threadId: context.session.threadId, turnId, itemId },
          ),
        );
      });

    const applyRemoteState = (
      context: DevinSessionContext,
      remoteStatus: string | null,
      remoteStatusDetail: string | null,
    ) =>
      Effect.gen(function* () {
        if (
          context.lastRemoteStatus === remoteStatus &&
          context.lastRemoteStatusDetail === remoteStatusDetail
        ) {
          return;
        }
        context.lastRemoteStatus = remoteStatus;
        context.lastRemoteStatusDetail = remoteStatusDetail;
        const runtimeState = sessionStateFromRemote(remoteStatus, remoteStatusDetail);
        context.session = {
          ...context.session,
          status:
            runtimeState === "error"
              ? "error"
              : runtimeState === "running"
                ? "running"
                : runtimeState === "stopped"
                  ? "closed"
                  : "ready",
          updatedAt: nowIso(),
        };
        yield* emit(
          makeEvent(
            "session.state.changed",
            {
              state: runtimeState,
              reason: remoteStatusDetail ?? undefined,
              detail: {
                status: remoteStatus,
                statusDetail: remoteStatusDetail,
                sessionUrl: context.remote?.sessionUrl ?? null,
              },
            },
            { threadId: context.session.threadId, turnId: context.activeTurnId },
          ),
        );
        const warningMessage = runtimeWarningMessage(remoteStatusDetail);
        if (warningMessage) {
          yield* emit(
            makeEvent(
              remoteStatusDetail === "error" ? "runtime.error" : "runtime.warning",
              remoteStatusDetail === "error"
                ? {
                    message: warningMessage,
                    class: "provider_error",
                    detail: {
                      status: remoteStatus,
                      statusDetail: remoteStatusDetail,
                      sessionUrl: context.remote?.sessionUrl ?? null,
                    },
                  }
                : {
                    message: warningMessage,
                    detail: {
                      status: remoteStatus,
                      statusDetail: remoteStatusDetail,
                      sessionUrl: context.remote?.sessionUrl ?? null,
                    },
                  },
              { threadId: context.session.threadId, turnId: context.activeTurnId },
            ),
          );
        }

        if (
          context.activeTurnId &&
          (remoteStatus === "exit" ||
            remoteStatus === "error" ||
            remoteStatus === "suspended" ||
            remoteStatusDetail === "finished" ||
            remoteStatusDetail === "waiting_for_user" ||
            remoteStatusDetail === "waiting_for_approval")
        ) {
          yield* completeActiveTurn(context, remoteStatus, remoteStatusDetail);
        }
      });

    const pollOnce = (threadId: ThreadId, context: DevinSessionContext) =>
      Effect.gen(function* () {
        if (!context.remote) {
          return { continuePolling: false, delayMs: null as number | null };
        }
        const { client } = yield* getApiClient();
        const sessionResult = yield* client
          .getSession(context.remote.orgId, context.remote.devinId)
          .pipe(Effect.result);
        if (Result.isFailure(sessionResult)) {
          const error = sessionResult.failure;
          if (error instanceof DevinApiError && (error.status === 401 || error.status === 403)) {
            yield* emit(
              makeEvent(
                "runtime.error",
                {
                  message: "Devin polling lost authentication or permission access.",
                  class: "provider_error",
                  detail: {
                    status: error.status,
                    sessionUrl: context.remote.sessionUrl,
                  },
                },
                { threadId, turnId: context.activeTurnId },
              ),
            );
            yield* completeActiveTurn(context, "error", "error");
            return { continuePolling: false, delayMs: null as number | null };
          }
          return yield* toRequestError("DevinAdapter.poll.getSession", toApiDetail(error), error);
        }
        const session = sessionResult.success;
        context.remote = {
          orgId: context.remote.orgId,
          devinId: session.id,
          sessionUrl: session.url,
        };
        let cursor = context.lastMessageCursor;
        for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_POLL; pageIndex += 1) {
          const page = yield* client
            .listSessionMessages(context.remote.orgId, context.remote.devinId, {
              first: PAGE_SIZE,
              ...(cursor ? { after: cursor } : {}),
            })
            .pipe(
              Effect.mapError((error) =>
                toRequestError("DevinAdapter.poll.listSessionMessages", toApiDetail(error), error),
              ),
            );
          for (const message of page.items) {
            yield* emitMessageEvents(context, message);
          }
          if (page.endCursor) {
            cursor = page.endCursor;
            context.lastMessageCursor = page.endCursor;
          }
          if (!page.hasNextPage) {
            break;
          }
        }

        yield* applyRemoteState(context, session.status, session.statusDetail);
        yield* persistBinding(threadId, context);
        const delayMs = pollIntervalMs(session.status, session.statusDetail);
        return { continuePolling: delayMs !== null, delayMs };
      });

    const ensurePolling = (threadId: ThreadId, context: DevinSessionContext) =>
      Effect.sync(() => {
        if (context.pollFiber || !context.remote) {
          return;
        }
        const loop = Effect.gen(function* () {
          let failureDelayMs = 5_000;
          while (!context.stopped && context.remote) {
            const pollResult = yield* Effect.exit(pollOnce(threadId, context));
            if (pollResult._tag === "Success") {
              failureDelayMs = 5_000;
              if (!pollResult.value.continuePolling || pollResult.value.delayMs === null) {
                break;
              }
              yield* Effect.sleep(pollResult.value.delayMs);
              continue;
            }

            const message = Cause.pretty(pollResult.cause);
            yield* emit(
              makeEvent(
                "runtime.warning",
                {
                  message: "Devin polling failed; backing off before retrying.",
                  detail: { error: message },
                },
                { threadId, turnId: context.activeTurnId },
              ),
            );
            yield* Effect.sleep(failureDelayMs);
            failureDelayMs = Math.min(failureDelayMs + 5_000, 30_000);
          }
          context.pollFiber = null;
        });
        context.pollFiber = Effect.runFork(loop);
      });

    const getContext = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const context of sessions.values()) {
          context.stopped = true;
          if (context.pollFiber) {
            yield* Fiber.interrupt(context.pollFiber).pipe(Effect.ignore({ log: true }));
          }
        }
        yield* Queue.shutdown(runtimeEventQueue).pipe(Effect.ignore({ log: true }));
      }),
    );

    const adapter: DevinAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
        supportsUserInput: false,
        supportsRollback: false,
        supportsFileChangeApproval: false,
        resume: "basic",
        subagents: "none",
        attachments: "basic",
        replay: "basic",
        mcpConfig: "none",
      },
      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          const { orgId } = yield* getApiClient();
          const resumeCursor = parseResumeCursor(input.resumeCursor) ?? {
            orgId,
            devinId: null,
            lastMessageCursor: null,
            lastMessageEventId: null,
          };
          const remote =
            resumeCursor.devinId !== null
              ? {
                  orgId: resumeCursor.orgId,
                  devinId: resumeCursor.devinId,
                  sessionUrl: null,
                }
              : null;
          const now = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: remote ? "running" : "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd,
            model: input.modelSelection?.model ?? "devin-default",
            threadId: input.threadId,
            resumeCursor,
            createdAt: now,
            updatedAt: now,
          };
          const context: DevinSessionContext = {
            session,
            remote,
            activeTurnId: null,
            turns: [],
            pollFiber: null,
            lastMessageCursor: resumeCursor.lastMessageCursor ?? null,
            lastMessageEventId: resumeCursor.lastMessageEventId ?? null,
            seenMessageEventIds: (() => {
              const cache = new RecentEventIdCache(MAX_SEEN_MESSAGE_EVENT_IDS);
              if (resumeCursor.lastMessageEventId) {
                cache.add(resumeCursor.lastMessageEventId);
              }
              return cache;
            })(),
            lastRemoteStatus: null,
            lastRemoteStatusDetail: null,
            stopped: false,
          };
          sessions.set(input.threadId, context);
          yield* emit(
            makeEvent(
              "session.started",
              {
                message: remote
                  ? "Recovered local Devin session binding."
                  : "Initialized local Devin session binding.",
                resume: resumeCursor,
              },
              { threadId: input.threadId },
            ),
          );
          yield* emit(
            makeEvent(
              "session.state.changed",
              {
                state: remote ? "running" : "ready",
              },
              { threadId: input.threadId },
            ),
          );
          if (remote) {
            yield* emit(
              makeEvent(
                "thread.started",
                {
                  providerThreadId: remote.devinId,
                },
                { threadId: input.threadId },
              ),
            );
            yield* ensurePolling(input.threadId, context);
          }
          return session;
        }),
      sendTurn: (input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          const context = yield* getContext(input.threadId);
          const turnId = makeTurnId(input.threadId);
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
          context.session = {
            ...context.session,
            activeTurnId: turnId,
            model: input.modelSelection?.model ?? context.session.model,
            status: "running",
            updatedAt: nowIso(),
          };
          yield* emit(
            makeEvent(
              "turn.started",
              {
                model: input.modelSelection?.model ?? context.session.model,
              },
              { threadId: input.threadId, turnId },
            ),
          );
          const { client, orgId } = yield* getApiClient();

          if (!context.remote) {
            const attachmentUrls: string[] = [];
            for (const attachment of input.attachments ?? []) {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* toValidationError(
                  "DevinAdapter.sendTurn",
                  `Could not resolve attachment '${attachment.id}' from the attachment store.`,
                );
              }
              const uploaded = yield* Effect.tryPromise(() =>
                readFile(attachmentPath).then(
                  (bytes) => new Blob([bytes], { type: attachment.mimeType }),
                ),
              ).pipe(
                Effect.flatMap((file) => client.createAttachment(orgId, file, attachment.name)),
                Effect.mapError((error) =>
                  toRequestError("DevinAdapter.createAttachment", toApiDetail(error), error),
                ),
              );
              attachmentUrls.push(uploaded.url);
            }

            const created = yield* client
              .createSession(orgId, {
                prompt: input.input ?? "",
                attachmentUrls,
                title: String(input.threadId),
              })
              .pipe(
                Effect.mapError((error) =>
                  toRequestError("DevinAdapter.createSession", toApiDetail(error), error),
                ),
              );
            context.remote = {
              orgId,
              devinId: created.id,
              sessionUrl: created.url,
            };
            yield* emit(
              makeEvent(
                "thread.started",
                {
                  providerThreadId: created.id,
                },
                { threadId: input.threadId, turnId },
              ),
            );
            yield* applyRemoteState(context, created.status, created.statusDetail);
            yield* persistBinding(input.threadId, context);
            yield* ensurePolling(input.threadId, context);
          } else {
            if ((input.attachments ?? []).length > 0) {
              return yield* toValidationError(
                "DevinAdapter.sendTurn",
                "Devin attachments are only supported on the first turn.",
              );
            }
            yield* client
              .sendSessionMessage(context.remote.orgId, context.remote.devinId, {
                message: input.input ?? "",
              })
              .pipe(
                Effect.mapError((error) =>
                  toRequestError("DevinAdapter.sendSessionMessage", toApiDetail(error), error),
                ),
              );
            yield* persistBinding(input.threadId, context);
            yield* ensurePolling(input.threadId, context);
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: makeResumeCursor({
              orgId,
              remote: context.remote,
              lastMessageCursor: context.lastMessageCursor,
              lastMessageEventId: context.lastMessageEventId,
            }),
          };
        }),
      interruptTurn: (threadId) =>
        Effect.fail(
          toRequestError(
            "DevinAdapter.interruptTurn",
            `Interrupt is not supported for Devin thread '${threadId}'.`,
          ),
        ),
      respondToRequest: (_threadId, _requestId, _decision) =>
        Effect.fail(
          toRequestError(
            "DevinAdapter.respondToRequest",
            "Programmatic approval resolution is not supported for Devin.",
          ),
        ),
      respondToUserInput: (_threadId, _requestId, _answers) =>
        Effect.fail(
          toRequestError(
            "DevinAdapter.respondToUserInput",
            "Programmatic user-input resolution is not supported for Devin.",
          ),
        ),
      stopSession: (threadId) =>
        Effect.gen(function* () {
          const context = yield* getContext(threadId);
          context.stopped = true;
          if (context.pollFiber) {
            yield* Fiber.interrupt(context.pollFiber).pipe(Effect.ignore({ log: true }));
            context.pollFiber = null;
          }
          if (context.remote) {
            const { client } = yield* getApiClient();
            yield* client
              .archiveSession(context.remote.orgId, context.remote.devinId)
              .pipe(
                Effect.mapError((error) =>
                  toRequestError("DevinAdapter.stopSession", toApiDetail(error), error),
                ),
              );
          }
          context.session = {
            ...context.session,
            status: "closed",
            updatedAt: nowIso(),
          };
          sessions.delete(threadId);
        }),
      listSessions: () =>
        Effect.succeed(Array.from(sessions.values()).map((context) => context.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.gen(function* () {
          const context = yield* getContext(threadId);
          return {
            threadId,
            turns: context.turns,
          } satisfies ProviderThreadSnapshot;
        }),
      rollbackThread: (threadId, _numTurns) =>
        Effect.fail(
          toRequestError(
            "DevinAdapter.rollbackThread",
            `Rollback is not supported for Devin thread '${threadId}'.`,
          ),
        ),
      stopAll: () =>
        Effect.gen(function* () {
          for (const [threadId, context] of sessions.entries()) {
            context.stopped = true;
            if (context.pollFiber) {
              yield* Fiber.interrupt(context.pollFiber).pipe(Effect.ignore({ log: true }));
            }
            sessions.delete(threadId);
          }
        }),
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    };

    return adapter;
  }),
);
