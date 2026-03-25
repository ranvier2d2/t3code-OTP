/**
 * codexEventMapping - Pure event-mapping functions for the Codex provider.
 *
 * Extracted from CodexAdapter.ts so these functions can be reused by other
 * adapters (e.g. HarnessClientAdapter) without pulling in the full adapter
 * implementation.
 *
 * @module codexEventMapping
 */
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Primitive coercions
// ---------------------------------------------------------------------------

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Status / type normalisation
// ---------------------------------------------------------------------------

export function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

export function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Item display helpers
// ---------------------------------------------------------------------------

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request type resolution
// ---------------------------------------------------------------------------

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// User-input helpers
// ---------------------------------------------------------------------------

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asObject(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
      };
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

// ---------------------------------------------------------------------------
// Thread / content stream helpers
// ---------------------------------------------------------------------------

export function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

export function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

// ---------------------------------------------------------------------------
// Branded ID helpers
// ---------------------------------------------------------------------------

export function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

// ---------------------------------------------------------------------------
// Event base builders
// ---------------------------------------------------------------------------

export function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

export function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  // Prefer event-level turn/item/request ids (set by the adapter manager)
  // over msg-level ids (which may reference child/sub-agent ids)
  const turnId = asString(event.turnId) ?? asString(msg?.turn_id) ?? asString(msg?.turnId);
  const itemId = asString(event.itemId) ?? asString(msg?.item_id) ?? asString(msg?.itemId);
  const requestId =
    asString(event.requestId) ?? asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: ProviderItemId.makeUnsafe(itemId) } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: ProviderItemId.makeUnsafe(itemId) } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(ProviderItemId.makeUnsafe(itemId)) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

export function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
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
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Item lifecycle mapper
// ---------------------------------------------------------------------------

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(source, payload ?? {});
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Main mapping function
// ---------------------------------------------------------------------------

/**
 * Known non-critical events that fire frequently but don't need mapping.
 * Defined at module level so the Set isn't recreated on every call.
 */
const QUIET_UNMAPPED_EVENTS = new Set([
  "file.watcher.updated",
  "session.diff",
  "session.created",
  "mcp_startup_update",
  "mcp_startup_complete",
  "rate_limit_event",
  "stream_event",
  "hook_started",
  "hook_response",
  "user",
  "thinking",
  "codex/event/agent_message_delta",
  "codex/event/agent_message",
  "codex/event/agent_message_content_delta",
  "codex/event/user_message",
]);

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    let decision: typeof ProviderApprovalDecision.Type | undefined;
    try {
      decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    } catch {
      decision = undefined;
    }
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
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

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
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
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
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
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          plan: steps
            .map((entry) => asObject(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              step: asString(entry.step) ?? "step",
              status:
                entry.status === "completed" || entry.status === "inProgress"
                  ? entry.status
                  : "pending",
            })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
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
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
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

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
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
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  // ---------------------------------------------------------------------------
  // Raw Codex events (codex/event/* prefix) — mapped to canonical runtime events
  // ---------------------------------------------------------------------------

  if (event.method === "codex/event/exec_command_begin") {
    const msg = asObject(payload?.msg) ?? payload;
    const command = asArray(msg?.command)?.join(" ") ?? asString(msg?.command);
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "item.started" as const,
        payload: {
          itemType: "command_execution" as CanonicalItemType,
          ...(command ? { title: command } : {}),
          ...(msg ? { data: { item: msg } } : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/exec_command_end") {
    const msg = asObject(payload?.msg) ?? payload;
    const command = asArray(msg?.command)?.join(" ") ?? asString(msg?.command);
    const detail =
      asString(msg?.formatted_output) ?? asString(msg?.aggregated_output) ?? asString(msg?.stdout);
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "item.completed" as const,
        payload: {
          itemType: "command_execution" as CanonicalItemType,
          ...(command ? { title: command } : {}),
          ...(detail ? { detail } : {}),
          ...(msg ? { data: { item: msg } } : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/exec_command_output_delta") {
    const msg = asObject(payload?.msg) ?? payload;
    const chunk = asString(msg?.chunk);
    if (!chunk) return [];
    // Codex sends base64-encoded output chunks
    let delta: string;
    try {
      delta = Buffer.from(chunk, "base64").toString("utf-8");
    } catch {
      return [];
    }
    if (!delta) return [];
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta" as const,
        payload: {
          streamKind: "command_output" as const,
          delta,
        },
      },
    ];
  }

  if (
    event.method === "codex/event/item_started" ||
    event.method === "codex/event/item_completed"
  ) {
    const msg = asObject(payload?.msg) ?? payload;
    const item = asObject(msg?.item);
    const itemType = toCanonicalItemType(item?.type);
    // Skip user messages and agent messages (handled elsewhere)
    if (itemType === "user_message" || itemType === "assistant_message") return [];
    const title = itemTitle(itemType);
    const runtimeType =
      event.method === "codex/event/item_started" ? "item.started" : "item.completed";
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: runtimeType as "item.started" | "item.completed",
        payload: {
          itemType,
          ...(title ? { title } : {}),
          ...(item ? { data: { item } } : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/token_count") {
    const msg = asObject(payload?.msg) ?? payload;
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "thread.token-usage.updated" as const,
        payload: { usage: msg?.info ?? msg ?? {} },
      },
    ];
  }

  if (event.method === "codex/event/plan_delta") {
    const msg = codexEventMessage(payload);
    const delta =
      asString(msg?.delta) ?? asString(msg?.text) ?? asString(asObject(msg?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta" as const,
        payload: { delta },
      },
    ];
  }

  // Log unmapped events to aid debugging — skip known-noisy non-critical ones.
  if (event.method && !QUIET_UNMAPPED_EVENTS.has(event.method)) {
    console.debug(`[codexEventMapping] unmapped event: ${event.method}`, event.payload ?? "");
  }
  return [];
}
