/**
 * HarnessClientAdapterLive — Effect Layer that bridges ProviderAdapterShape
 * to the Elixir HarnessService via HarnessClientManager.
 *
 * Responsibilities:
 *  - Spawn the Elixir Phoenix server as a child process (dev mode: `mix phx.server`).
 *  - Connect `HarnessClientManager` to the Elixir WebSocket.
 *  - Implement every method of `ProviderAdapterShape<ProviderAdapterError>` by
 *    delegating to the manager and mapping results / errors.
 *  - Convert raw `HarnessRawEvent` payloads to `ProviderRuntimeEvent` objects
 *    and stream them via an Effect `Queue`.
 *
 * @module HarnessClientAdapterLive
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  type ApprovalRequestId,
  type EventId,
  type IsoDateTime,
  type ProviderEvent,
  type ProviderItemId,
  type ProviderKind,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ItemLifecyclePayload,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  HarnessClientAdapter,
  type HarnessClientAdapterShape,
} from "../Services/HarnessClientAdapter.ts";
import { HARNESS_PROVIDER_CAPABILITIES } from "../providerCapabilities.ts";
import { McpConfigService } from "../Services/McpConfig.ts";
import { generatedMcpDir, mergeCodexToml, openCodeConfigFromResolved } from "../mcpTranslation.ts";
import { type HarnessRawEvent, HarnessClientManager } from "./HarnessClientManager.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { mapToRuntimeEvents as codexMapToRuntimeEvents } from "./codexEventMapping.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The harness adapter handles ALL providers — this is used only as a fallback
// for error context when the provider is not known from the request.
const DEFAULT_PROVIDER = "codex" as const;

export { HARNESS_PROVIDER_CAPABILITIES } from "../providerCapabilities.ts";

/** Default port the Elixir harness Phoenix app listens on. */
const DEFAULT_HARNESS_PORT = 4321;

/** Shared secret passed in the Phoenix channel join payload. */
const DEFAULT_HARNESS_SECRET = "dev-harness-secret";

/** Max milliseconds to wait for the Elixir harness to become ready. */
const SPAWN_READY_DELAY_MS = 2_000;

/** Probe the harness HTTP endpoint until it responds or timeout expires. */
function waitForHarnessReady(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    function probe() {
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      const req = http.get(`http://127.0.0.1:${port}/api/metrics`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(probe, 200));
      req.setTimeout(500, () => {
        req.destroy();
        setTimeout(probe, 200);
      });
    }
    probe();
  });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HarnessClientAdapterLiveOptions {
  /** Override the harness port (default 4321). */
  readonly harnessPort?: number;
  /** Override the shared secret (default "dev-harness-secret"). */
  readonly harnessSecret?: string;
  /**
   * Supply a pre-created manager instance (useful in tests).
   * When provided, process spawning is skipped entirely.
   */
  readonly manager?: HarnessClientManager;
}

// ---------------------------------------------------------------------------
// Internal helpers — error mapping
// ---------------------------------------------------------------------------

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  provider: string,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (
    normalized.includes("unknown session") ||
    normalized.includes("unknown provider session") ||
    normalized.includes("session not found")
  ) {
    return new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  provider: string,
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(provider, threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers — ProviderSession coercion
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function toSessionStatus(raw: unknown): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (raw) {
    case "connecting":
    case "ready":
    case "running":
    case "error":
    case "closed":
      return raw;
    default:
      return "connecting";
  }
}

function toRuntimeMode(raw: unknown): "approval-required" | "full-access" {
  return raw === "full-access" ? "full-access" : "approval-required";
}

function coerceSession(
  raw: unknown,
  threadId: ThreadId,
  providerOverride?: ProviderKind,
): ProviderSession {
  const obj = asObject(raw) ?? {};
  const now = new Date().toISOString() as IsoDateTime;
  return {
    provider: providerOverride ?? (asString(obj.provider) as ProviderKind) ?? DEFAULT_PROVIDER,
    threadId,
    status: toSessionStatus(obj.status),
    runtimeMode: toRuntimeMode(obj.runtime_mode ?? obj.runtimeMode),
    ...(asString(obj.cwd) ? { cwd: asString(obj.cwd) } : {}),
    ...(asString(obj.model) ? { model: asString(obj.model) } : {}),
    ...(obj.resume_cursor !== undefined ? { resumeCursor: obj.resume_cursor } : {}),
    ...(asString(obj.active_turn_id ?? obj.activeTurnId)
      ? { activeTurnId: asString(obj.active_turn_id ?? obj.activeTurnId) as TurnId }
      : {}),
    createdAt: (asString(obj.created_at ?? obj.createdAt) ?? now) as IsoDateTime,
    updatedAt: (asString(obj.updated_at ?? obj.updatedAt) ?? now) as IsoDateTime,
    ...(asString(obj.last_error ?? obj.lastError)
      ? { lastError: asString(obj.last_error ?? obj.lastError) }
      : {}),
  };
}

function coerceTurnStartResult(raw: unknown, threadId: ThreadId): ProviderTurnStartResult {
  const obj = asObject(raw) ?? {};
  const turnId = asString(obj.turn_id ?? obj.turnId) ?? `harness-turn-${Date.now()}`;
  return {
    threadId,
    turnId: turnId as TurnId,
    ...(obj.resume_cursor !== undefined ? { resumeCursor: obj.resume_cursor } : {}),
  };
}

function coerceSessionList(raw: unknown[]): ReadonlyArray<ProviderSession> {
  return raw
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return null;
      const threadId = asString(obj.thread_id ?? obj.threadId);
      if (!threadId) return null;
      return coerceSession(obj, threadId as ThreadId);
    })
    .filter((s): s is ProviderSession => s !== null);
}

// ---------------------------------------------------------------------------
// Internal helpers — HarnessRawEvent → ProviderEvent → ProviderRuntimeEvent
// ---------------------------------------------------------------------------

/**
 * Map a `HarnessRawEvent` (raw Phoenix push payload) to a `ProviderEvent`
 * shape compatible with the shared runtime event mapper.
 */
function rawToProviderEvent(raw: HarnessRawEvent): ProviderEvent {
  const payload = asObject(raw.payload) ?? {};
  return {
    id: raw.eventId as EventId,
    kind: (raw.kind === "session" ||
    raw.kind === "notification" ||
    raw.kind === "request" ||
    raw.kind === "error"
      ? raw.kind
      : "notification") as ProviderEvent["kind"],
    provider: raw.provider as ProviderKind,
    threadId: raw.threadId as ThreadId,
    createdAt: raw.createdAt as IsoDateTime,
    method: raw.method,
    ...(asString(payload.message) ? { message: asString(payload.message) } : {}),
    ...(asString(
      payload.turn_id ??
        payload.turnId ??
        asObject(payload.turn)?.id ??
        asObject(payload.msg)?.turn_id ??
        asObject(payload.msg)?.turnId,
    )
      ? {
          turnId: asString(
            payload.turn_id ??
              payload.turnId ??
              asObject(payload.turn)?.id ??
              asObject(payload.msg)?.turn_id ??
              asObject(payload.msg)?.turnId,
          ) as TurnId,
        }
      : {}),
    ...(asString(
      payload.item_id ??
        payload.itemId ??
        asObject(payload.msg)?.item_id ??
        asObject(payload.msg)?.itemId,
    )
      ? {
          itemId: asString(
            payload.item_id ??
              payload.itemId ??
              asObject(payload.msg)?.item_id ??
              asObject(payload.msg)?.itemId,
          ) as ProviderItemId,
        }
      : {}),
    ...(asString(payload.request_id ?? payload.requestId)
      ? {
          requestId: asString(payload.request_id ?? payload.requestId) as ApprovalRequestId,
        }
      : {}),
    ...(asString(payload.request_kind ?? payload.requestKind)
      ? {
          requestKind: asString(payload.request_kind ?? payload.requestKind) as ProviderRequestKind,
        }
      : {}),
    ...(asString(payload.text_delta ?? payload.textDelta)
      ? { textDelta: asString(payload.text_delta ?? payload.textDelta) }
      : {}),
    payload: raw.payload,
  };
}

// ---------------------------------------------------------------------------
// Minimal subset of the CodexAdapter event mapping re-used for the harness.
//
// The harness emits ProviderEvent-shaped notifications that map through the
// same runtime event algebra.  Rather than importing from CodexAdapter.ts
// (which would create a circular dependency risk), we inline the minimal
// mapping helpers needed for harness-specific events and fall through to a
// generic "notification" bucket for everything else.
// ---------------------------------------------------------------------------

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;
  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId as unknown as ProviderRuntimeEvent["itemId"] } : {}),
    ...(event.requestId
      ? { requestId: event.requestId as unknown as ProviderRuntimeEvent["requestId"] }
      : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source:
        event.kind === "request" ? ("harness.request" as const) : ("harness.notification" as const),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

/**
 * Map a `ProviderEvent` from the harness into zero-or-more `ProviderRuntimeEvent`s.
 *
 * The harness speaks the same event vocabulary as the Codex provider (session.*,
 * turn.*, item.*, etc.) so most methods map 1-to-1 against the canonical types.
 * Unknown methods produce a generic `runtime.warning` rather than being silently
 * dropped, so operators can see unrecognised events.
 */
function mapHarnessEventToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);

  // -------------------------------------------------------------------------
  // Error kind
  // -------------------------------------------------------------------------
  if (event.kind === "error") {
    if (!event.message) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error" as const,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Approval / user-input requests
  // -------------------------------------------------------------------------
  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput" || event.method === "user-input/requested") {
      const questions = asArray(payload?.questions);
      if (!questions || questions.length === 0) return [];
      const parsed = questions
        .map(asObject)
        .filter((q): q is Record<string, unknown> => q !== undefined)
        .map((q) => ({
          id: asString(q.id) ?? "",
          header: asString(q.header) ?? asString(q.question) ?? "",
          question: asString(q.question) ?? "",
          options: (asArray(q.options) ?? [])
            .map(asObject)
            .filter((o): o is Record<string, unknown> => o !== undefined)
            .map((o) => ({
              label: asString(o.label) ?? "",
              description: asString(o.description) ?? "",
            }))
            .filter((o) => o.label && o.description),
        }))
        .filter((q) => q.id && q.question);
      if (parsed.length === 0) return [];
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: { questions: parsed },
        },
      ];
    }

    const requestType = asString(payload?.requestType) ?? "unknown";
    const detail =
      asString(payload?.detail) ??
      asString(payload?.command) ??
      asString(payload?.reason) ??
      asString(payload?.prompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: requestType as "unknown",
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------
  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: "starting", ...(event.message ? { reason: event.message } : {}) },
      },
    ];
  }
  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: "ready", ...(event.message ? { reason: event.message } : {}) },
      },
    ];
  }
  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }
  if (event.method === "session/configured") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: "ready" },
      },
    ];
  }
  if (event.method === "session/state-changed") {
    const state = asString(payload?.state) ?? "running";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: { state: state as "starting" | "ready" | "running" | "waiting" | "error" },
      },
    ];
  }
  if (event.method === "session/error") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: asString(payload?.error) ?? "Session error",
          class: "provider_error" as const,
        },
      },
    ];
  }
  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" as const } : {}),
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Thread lifecycle
  // -------------------------------------------------------------------------
  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id) ?? asString(payload?.threadId);
    if (!payloadThreadId) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: { providerThreadId: payloadThreadId },
      },
    ];
  }
  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const state =
      event.method === "thread/archived"
        ? ("archived" as const)
        : event.method === "thread/closed"
          ? ("closed" as const)
          : event.method === "thread/compacted"
            ? ("compacted" as const)
            : (asString(asObject(payload?.thread)?.state ?? payload?.state) ?? "active");
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.state.changed",
        payload: {
          state: state as "active" | "idle" | "archived" | "closed" | "compacted" | "error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }
  if (event.method === "thread/name/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.metadata.updated",
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: payload } : {}),
        },
      },
    ];
  }
  if (event.method === "thread/tokenUsage/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.token-usage.updated",
        payload: { usage: (event.payload ?? {}) as ThreadTokenUsageSnapshot },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------
  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) return [];
    const turn = asObject(payload?.turn);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }
  if (event.method === "turn/completed") {
    const turn = asObject(payload?.turn);
    const errorMessage = asString(asObject(turn?.error)?.message);
    const status = asString(turn?.status);
    const turnStatus: "completed" | "failed" | "cancelled" | "interrupted" =
      status === "failed" || status === "cancelled" || status === "interrupted"
        ? status
        : "completed";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: turnStatus,
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }
  if (event.method === "turn/proposed-completed") {
    const planMarkdown = asString(payload?.planMarkdown);
    if (planMarkdown) {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: { planMarkdown },
        },
      ];
    }
    return [];
  }
  if (event.method === "thread/token-usage-updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.token-usage.updated",
        payload: { usage: (event.payload ?? {}) as ThreadTokenUsageSnapshot },
      },
    ];
  }
  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: { reason: event.message ?? "Turn aborted" },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Item lifecycle (tool calls from all providers)
  // -------------------------------------------------------------------------
  if (event.method === "item/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started" as const,
        payload: {
          itemType: (asString(payload?.itemType) ??
            "dynamic_tool_call") as ItemLifecyclePayload["itemType"],
          ...(asString(payload?.toolName) ? { title: asString(payload?.toolName) } : {}),
        },
      },
    ];
  }
  if (event.method === "item/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated" as const,
        payload: {
          itemType: (asString(payload?.itemType) ??
            "dynamic_tool_call") as ItemLifecyclePayload["itemType"],
          ...(asString(payload?.toolName) ? { title: asString(payload?.toolName) } : {}),
        },
      },
    ];
  }
  if (event.method === "item/completed") {
    // Resolve itemType from explicit field, nested item object, or default.
    // Never default to "assistant_message" — that creates phantom empty responses
    // when providers send item/completed for non-text items without itemType.
    const item = asObject(payload?.item);
    const resolvedItemType =
      asString(payload?.itemType) ??
      asString(item?.type) ??
      asString(item?.kind) ??
      "dynamic_tool_call";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed" as const,
        payload: {
          itemType: resolvedItemType as ItemLifecyclePayload["itemType"],
          ...(asString(payload?.toolName) ? { title: asString(payload?.toolName) } : {}),
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Subagent lifecycle (OpenCode child sessions, Codex collaboration,
  // Claude task_progress/task_notification from --print mode)
  // -------------------------------------------------------------------------
  if (event.method === "collab_agent_spawn_begin") {
    const agentName = asString(payload?.agentName) ?? "subagent";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started" as const,
        payload: {
          itemType: "collab_agent_tool_call" as ItemLifecyclePayload["itemType"],
          ...(agentName ? { title: agentName } : {}),
        },
      },
    ];
  }

  // Claude --print mode emits task_progress/task_notification as system messages
  // that pass through the Elixir harness without the "codex/event/" prefix.
  if (event.method === "task_progress") {
    const description = asString(payload?.description) ?? "";
    const lastToolName = asString(payload?.last_tool_name);
    if (!description && !lastToolName) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started" as const,
        payload: {
          itemType: (lastToolName
            ? "dynamic_tool_call"
            : "collab_agent_tool_call") as ItemLifecyclePayload["itemType"],
          ...(lastToolName ? { title: lastToolName } : {}),
          ...(description ? { detail: description } : {}),
        },
      },
    ];
  }
  if (event.method === "task_notification") {
    const summary = asString(payload?.summary) ?? "";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed" as const,
        payload: {
          itemType: "collab_agent_tool_call" as ItemLifecyclePayload["itemType"],
          ...(summary ? { title: summary } : {}),
        },
      },
    ];
  }
  if (event.method === "collab_waiting_begin") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started" as const,
        payload: {
          itemType: "collab_agent_tool_call" as ItemLifecyclePayload["itemType"],
          title: "Waiting for subagent",
        },
      },
    ];
  }
  if (event.method === "collab_waiting_end") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed" as const,
        payload: {
          itemType: "collab_agent_tool_call" as ItemLifecyclePayload["itemType"],
          title: "Subagent completed",
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Content deltas
  // -------------------------------------------------------------------------

  // Canonical content/delta from Elixir GenServers (all providers emit this)
  if (event.method === "content/delta") {
    const streamKind = asString(payload?.streamKind) ?? "assistant_text";
    const delta = asString(payload?.delta);
    if (!delta || delta.length === 0) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: streamKind as
            | "assistant_text"
            | "reasoning_text"
            | "reasoning_summary_text"
            | "command_output"
            | "file_change_output"
            | "plan_text",
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) return [];
    const streamKind: ProviderRuntimeEvent extends {
      type: "content.delta";
      payload: { streamKind: infer K };
    }
      ? K
      : string =
      event.method === "item/reasoning/textDelta"
        ? "reasoning_text"
        : event.method === "item/reasoning/summaryTextDelta"
          ? "reasoning_summary_text"
          : event.method === "item/commandExecution/outputDelta"
            ? "command_output"
            : event.method === "item/fileChange/outputDelta"
              ? "file_change_output"
              : "assistant_text";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: streamKind as
            | "assistant_text"
            | "reasoning_text"
            | "reasoning_summary_text"
            | "command_output"
            | "file_change_output"
            | "plan_text",
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Approval resolution
  // -------------------------------------------------------------------------
  if (event.method === "request/resolved") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType: (asString(payload?.requestType) ?? "unknown") as "unknown",
          ...(asString(payload?.decision) ? { decision: asString(payload?.decision) } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }
  if (event.method === "user-input/resolved") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: (asObject(payload)?.answers ?? {}) as ProviderUserInputAnswers,
        },
      },
    ];
  }
  if (event.method === "serverRequest/resolved") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType: "unknown" as const,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }
  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: (asObject(event.payload)?.answers ?? {}) as ProviderUserInputAnswers,
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Fallback: try provider-specific event mapping (e.g. codex/event/* methods
  // that pass through the GenServer as raw JSON-RPC notification methods).
  // -------------------------------------------------------------------------
  const providerMapped = codexMapToRuntimeEvents(event, canonicalThreadId);
  if (providerMapped.length > 0) {
    return providerMapped;
  }

  // Unmapped events are already logged by codexMapToRuntimeEvents (which
  // handles both QUIET_UNMAPPED_EVENTS suppression and console.debug for
  // genuinely unknown methods). No additional logging needed here.
  return [];
}

// ---------------------------------------------------------------------------
// Thread snapshot coercion
// ---------------------------------------------------------------------------

import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

function coerceThreadSnapshot(raw: unknown, threadId: ThreadId): ProviderThreadSnapshot {
  const obj = asObject(raw) ?? {};
  const turns = asArray(obj.turns) ?? [];
  return {
    threadId,
    turns: turns
      .map(asObject)
      .filter((t): t is Record<string, unknown> => t !== undefined)
      .map((t) => ({
        id: (asString(t.id ?? t.turn_id) ?? `harness-turn-${Math.random()}`) as TurnId,
        items: asArray(t.items) ?? [],
      })),
  };
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

export function makeHarnessClientAdapterLive(options?: HarnessClientAdapterLiveOptions) {
  return Layer.effect(
    HarnessClientAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* Effect.service(ServerConfig);
      const serverSettings = yield* ServerSettingsService;
      const mcpConfigService = yield* Effect.service(McpConfigService);

      const harnessPort = options?.harnessPort ?? serverConfig.harnessPort ?? DEFAULT_HARNESS_PORT;
      const harnessSecret =
        options?.harnessSecret ?? serverConfig.harnessSecret ?? DEFAULT_HARNESS_SECRET;

      const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      // -------------------------------------------------------------------
      // Acquire / release: spawn the Elixir process + connect the manager
      // -------------------------------------------------------------------

      const manager = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          // If a pre-built manager was supplied (e.g. in tests), skip spawning.
          if (options?.manager) {
            yield* Effect.tryPromise({
              try: () => options.manager!.connect(),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: DEFAULT_PROVIDER,
                  threadId: "harness" as ThreadId,
                  detail: toMessage(cause, "Failed to connect to harness WebSocket."),
                  cause,
                }),
            });
            return options.manager;
          }

          // The Elixir HarnessService must be started externally before the Node server.
          // In dev: cd apps/harness && T3CODE_HARNESS_PORT=4383 mix phx.server
          yield* Effect.log(`Connecting to Elixir HarnessService on port ${harnessPort}...`);

          // Wait for Phoenix to be ready by probing the health endpoint.
          // Falls back to a fixed delay if the probe doesn't succeed in time.
          yield* Effect.promise(() =>
            waitForHarnessReady(harnessPort, SPAWN_READY_DELAY_MS).catch(
              () => new Promise<void>((r) => setTimeout(r, SPAWN_READY_DELAY_MS)),
            ),
          );

          // Create and connect the manager.
          const mgr = new HarnessClientManager({
            harnessPort,
            harnessSecret,
            onEvent: (raw) => {
              const providerEvent = rawToProviderEvent(raw);
              const runtimeEvents = mapHarnessEventToRuntimeEvents(
                providerEvent,
                providerEvent.threadId,
              );
              if (runtimeEvents.length === 0) {
                void Effect.runPromise(
                  Effect.logDebug("ignoring unhandled harness provider event", {
                    method: raw.method,
                    threadId: raw.threadId,
                  }),
                );
                return;
              }
              void Effect.runPromise(Queue.offerAll(runtimeEventQueue, runtimeEvents));
            },
            onSessionChanged: (_data) => {
              // Session change notifications are surfaced via normal event flow.
            },
            onDisconnect: () => {
              void Effect.runPromise(
                Effect.logInfo("[harness] WebSocket disconnected — waiting for reconnect"),
              );
            },
            onReconnect: () => {
              void Effect.runPromise(Effect.logInfo("[harness] WebSocket reconnected"));
            },
          });

          yield* Effect.tryPromise({
            try: () => mgr.connect(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: DEFAULT_PROVIDER,
                threadId: "harness" as ThreadId,
                detail: toMessage(cause, "Failed to connect to harness WebSocket."),
                cause,
              }),
          });

          return mgr;
        }),
        (mgr) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              mgr.disconnect();
            });
            yield* Queue.shutdown(runtimeEventQueue);
          }),
      );

      // -------------------------------------------------------------------
      // Session → provider tracking (for error context)
      // -------------------------------------------------------------------

      const sessionProviderMap = new Map<string, string>();
      const resolveProvider = (threadId: ThreadId): string =>
        sessionProviderMap.get(threadId) ?? DEFAULT_PROVIDER;

      // -------------------------------------------------------------------
      // Adapter method implementations
      // -------------------------------------------------------------------

      const startSession: HarnessClientAdapterShape["startSession"] = (input) => {
        // The harness adapter handles all providers — routing happens in Elixir.
        const provider = input.provider ?? DEFAULT_PROVIDER;

        return Effect.gen(function* () {
          const resolvedMcp = yield* mcpConfigService.getSnapshot(input.threadId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider,
                  threadId: input.threadId,
                  detail: "Failed to read server settings for harness session startup.",
                  cause,
                }),
            ),
          );
          const baseCodexHomePath = settings.providers.codex.homePath.trim() || undefined;
          const providerOptions =
            resolvedMcp && resolvedMcp.servers.length > 0
              ? yield* Effect.try({
                  try: () => {
                    switch (provider) {
                      case "codex": {
                        const generatedDir = generatedMcpDir(
                          serverConfig.stateDir,
                          "codex",
                          input.threadId,
                        );
                        fs.rmSync(generatedDir, { recursive: true, force: true });
                        const generatedHomePath = path.join(generatedDir, "home");
                        fs.mkdirSync(generatedHomePath, { recursive: true });
                        if (
                          baseCodexHomePath &&
                          fs.existsSync(baseCodexHomePath) &&
                          baseCodexHomePath !== generatedHomePath
                        ) {
                          // Copying from baseCodexHomePath intentionally overwrites files in
                          // generatedHomePath so fs.cpSync(force: true) leaves a clean,
                          // session-specific Codex home.
                          fs.cpSync(baseCodexHomePath, generatedHomePath, {
                            recursive: true,
                            force: true,
                          });
                        }
                        const configTomlPath = path.join(generatedHomePath, "config.toml");
                        const existingConfig = fs.existsSync(configTomlPath)
                          ? fs.readFileSync(configTomlPath, "utf8")
                          : "";
                        fs.writeFileSync(
                          configTomlPath,
                          mergeCodexToml(existingConfig, resolvedMcp),
                          "utf8",
                        );
                        return {
                          codex: {
                            homePath: generatedHomePath,
                          },
                        };
                      }
                      case "opencode": {
                        const generatedDir = generatedMcpDir(
                          serverConfig.stateDir,
                          "opencode",
                          input.threadId,
                        );
                        fs.mkdirSync(generatedDir, { recursive: true });
                        const configPath = path.join(generatedDir, "opencode.json");
                        fs.writeFileSync(
                          configPath,
                          openCodeConfigFromResolved(resolvedMcp),
                          "utf8",
                        );
                        return {
                          opencode: {
                            configPath,
                          },
                        };
                      }
                      default:
                        return undefined;
                    }
                  },
                  catch: (cause) =>
                    new ProviderAdapterProcessError({
                      provider,
                      threadId: input.threadId,
                      detail: "Failed to materialize harness MCP configuration.",
                      cause,
                    }),
                })
              : undefined;

          return yield* Effect.tryPromise({
            try: () =>
              manager.startSession({
                threadId: input.threadId,
                provider,
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
                ...(input.modelSelection?.model !== undefined
                  ? { model: input.modelSelection.model }
                  : {}),
                runtimeMode: input.runtimeMode,
                ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
                ...(providerOptions ? { providerOptions } : {}),
              }),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start harness session."),
                cause,
              }),
          });
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sessionProviderMap.set(input.threadId, provider);
              sessionListCache = null;
            }),
          ),
          Effect.map((raw) => coerceSession(raw, input.threadId, input.provider as ProviderKind)),
        );
      };

      const sendTurn: HarnessClientAdapterShape["sendTurn"] = (input) =>
        Effect.tryPromise({
          try: () =>
            manager.sendTurn(input.threadId, {
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.modelSelection?.model !== undefined
                ? { model: input.modelSelection.model }
                : {}),
              ...(input.attachments !== undefined && input.attachments.length > 0
                ? { attachments: input.attachments }
                : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
            }),
          catch: (cause) =>
            toRequestError(resolveProvider(input.threadId), input.threadId, "turn/start", cause),
        }).pipe(Effect.map((raw) => coerceTurnStartResult(raw, input.threadId)));

      const interruptTurn: HarnessClientAdapterShape["interruptTurn"] = (threadId, turnId) =>
        Effect.tryPromise({
          try: () => manager.interruptTurn(threadId, turnId),
          catch: (cause) =>
            toRequestError(resolveProvider(threadId), threadId, "turn/interrupt", cause),
        });

      const respondToRequest: HarnessClientAdapterShape["respondToRequest"] = (
        threadId,
        requestId,
        decision,
      ) => {
        return Effect.tryPromise({
          try: () => {
            const decisionStr = Schema.encodeUnknownSync(Schema.Unknown)(decision);
            return manager.respondToApproval(
              threadId,
              requestId,
              typeof decisionStr === "string" ? decisionStr : JSON.stringify(decisionStr),
            );
          },
          catch: (cause) =>
            toRequestError(
              resolveProvider(threadId),
              threadId,
              "item/requestApproval/decision",
              cause,
            ),
        });
      };

      const respondToUserInput: HarnessClientAdapterShape["respondToUserInput"] = (
        threadId,
        requestId,
        answers,
      ) =>
        Effect.tryPromise({
          try: () =>
            manager.respondToUserInput(threadId, requestId, answers as Record<string, unknown>),
          catch: (cause) =>
            toRequestError(
              resolveProvider(threadId),
              threadId,
              "item/tool/requestUserInput",
              cause,
            ),
        });

      const stopSession: HarnessClientAdapterShape["stopSession"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.stopSession(threadId),
          catch: (cause) =>
            toRequestError(resolveProvider(threadId), threadId, "session/stop", cause),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sessionProviderMap.delete(threadId);
              sessionListCache = null;
            }),
          ),
        );

      // Cache listSessions to reduce polling pressure on the Elixir harness.
      // hasSession() calls listSessions() on every check — without caching this
      // produces dozens of WebSocket round-trips per second.
      let sessionListCache: { sessions: ReadonlyArray<ProviderSession>; ts: number } | null = null;
      const SESSION_LIST_CACHE_TTL_MS = 500;

      const listSessions: HarnessClientAdapterShape["listSessions"] = () => {
        const now = Date.now();
        if (sessionListCache && now - sessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
          return Effect.succeed(sessionListCache.sessions);
        }
        return Effect.tryPromise({
          try: () => manager.listSessions(),
          catch: () =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "listSessions",
              detail: "Failed to list sessions",
            }),
        }).pipe(
          Effect.map((raw) => coerceSessionList(raw)),
          Effect.tap((sessions) =>
            Effect.sync(() => {
              sessionListCache = { sessions, ts: Date.now() };
              for (const s of sessions) {
                if (s.threadId && !sessionProviderMap.has(s.threadId)) {
                  sessionProviderMap.set(s.threadId, (s as any).provider ?? DEFAULT_PROVIDER);
                }
              }
            }),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ProviderSession>),
        );
      };

      const hasSession: HarnessClientAdapterShape["hasSession"] = (threadId) =>
        listSessions().pipe(
          Effect.map((sessions) => sessions.some((s) => s.threadId === threadId)),
        );

      const readThread: HarnessClientAdapterShape["readThread"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.readThread(threadId),
          catch: (cause) =>
            toRequestError(resolveProvider(threadId), threadId, "thread/read", cause),
        }).pipe(Effect.map((raw) => coerceThreadSnapshot(raw, threadId)));

      const rollbackThread: HarnessClientAdapterShape["rollbackThread"] = (threadId, numTurns) => {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: resolveProvider(threadId),
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            }),
          );
        }
        return Effect.tryPromise({
          try: () => manager.rollbackThread(threadId, numTurns),
          catch: (cause) =>
            toRequestError(resolveProvider(threadId), threadId, "thread/rollback", cause),
        }).pipe(Effect.map((raw) => coerceThreadSnapshot(raw, threadId)));
      };

      const stopAll: HarnessClientAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: () => manager.stopAll(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "sessions/stopAll",
              detail: toMessage(cause, "Failed to stop all harness sessions."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sessionProviderMap.clear();
              sessionListCache = null;
            }),
          ),
        );

      const listModels: HarnessClientAdapterShape["listModels"] = (provider) =>
        Effect.tryPromise({
          try: () => manager.listProviderModels(provider),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: provider as ProviderKind,
              method: "listModels",
              detail: toMessage(cause, `Failed to discover models for ${provider}.`),
              cause,
            }),
        }).pipe(
          Effect.tapError(Effect.logWarning),
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ slug: string; name: string }>),
        );

      // -------------------------------------------------------------------
      // MCP Management (OpenCode only)
      // -------------------------------------------------------------------

      const mcpStatus: HarnessClientAdapterShape["mcpStatus"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.mcpStatus(threadId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "mcp/status",
              detail: toMessage(cause, "Failed to get MCP status."),
              cause,
            }),
        });

      const mcpAdd: HarnessClientAdapterShape["mcpAdd"] = (threadId, name, config) =>
        Effect.tryPromise({
          try: () => manager.mcpAdd(threadId, name, config),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "mcp/add",
              detail: toMessage(cause, `Failed to add MCP server "${name}".`),
              cause,
            }),
        });

      const mcpConnect: HarnessClientAdapterShape["mcpConnect"] = (threadId, name) =>
        Effect.tryPromise({
          try: () => manager.mcpConnect(threadId, name),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "mcp/connect",
              detail: toMessage(cause, `Failed to connect MCP server "${name}".`),
              cause,
            }),
        });

      const mcpDisconnect: HarnessClientAdapterShape["mcpDisconnect"] = (threadId, name) =>
        Effect.tryPromise({
          try: () => manager.mcpDisconnect(threadId, name),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DEFAULT_PROVIDER,
              method: "mcp/disconnect",
              detail: toMessage(cause, `Failed to disconnect MCP server "${name}".`),
              cause,
            }),
        });

      // -------------------------------------------------------------------
      // Assemble the adapter shape
      // -------------------------------------------------------------------

      return {
        provider: DEFAULT_PROVIDER,
        capabilities: HARNESS_PROVIDER_CAPABILITIES[DEFAULT_PROVIDER] ?? {
          sessionModelSwitch: "restart-session" as const,
          supportsUserInput: true,
          supportsRollback: true,
          supportsFileChangeApproval: true,
          resume: "full",
          subagents: "none",
          attachments: "basic",
          replay: "full",
          mcpConfig: "basic",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        listModels,
        mcpStatus,
        mcpAdd,
        mcpConnect,
        mcpDisconnect,
        streamEvents: Stream.fromQueue(runtimeEventQueue),
      } satisfies HarnessClientAdapterShape;
    }),
  );
}
