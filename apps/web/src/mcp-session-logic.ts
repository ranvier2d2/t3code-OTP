import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { humanizeMcpServerName, normalizeMcpServerName } from "@t3tools/shared/mcp";

import { compareActivitiesByOrder, parseMcpStartupWarningDetail } from "./session-logic";

export type McpSessionServerState =
  | "starting"
  | "ready"
  | "failed"
  | "cancelled"
  | "warning"
  | "unknown";

export interface McpSessionServerViewModel {
  server: string;
  displayName: string;
  state: McpSessionServerState;
  authExpired: boolean;
  message: string | null;
  remediationCommand: string | null;
  lastEventAt: string | null;
}

export interface McpSessionViewModel {
  servers: McpSessionServerViewModel[];
  hasAnyMcpActivity: boolean;
}

interface MutableServerState {
  server: string;
  statusState: Exclude<McpSessionServerState, "warning" | "unknown"> | "unknown";
  statusMessage: string | null;
  statusAt: string | null;
  warningMessage: string | null;
  remediationCommand: string | null;
  warningAt: string | null;
  oauthSuccessAt: string | null;
  authExpired: boolean;
}

interface ParsedMcpStatus {
  state: "starting" | "ready" | "failed" | "cancelled" | "unknown";
  error?: string;
}

const STATE_PRIORITY: Record<McpSessionServerState, number> = {
  warning: 0,
  failed: 1,
  cancelled: 2,
  starting: 3,
  ready: 4,
  unknown: 5,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseMcpStatus(value: unknown): ParsedMcpStatus | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (
    record.state !== "starting" &&
    record.state !== "ready" &&
    record.state !== "failed" &&
    record.state !== "cancelled"
  ) {
    return { state: "unknown" };
  }
  if (record.state === "failed") {
    return {
      state: "failed",
      ...(typeof record.error === "string" ? { error: record.error } : {}),
    };
  }
  return { state: record.state };
}

function parseMcpStatusUpdatedPayload(
  value: unknown,
): { server: string; status: ParsedMcpStatus } | null {
  const record = asRecord(value);
  const server = asTrimmedString(record?.server);
  const status = parseMcpStatus(record?.status);
  if (!server || !status) {
    return null;
  }
  return { server, status };
}

function parseOauthCompletedPayload(
  value: unknown,
): { success: boolean; name: string | null } | null {
  const record = asRecord(value);
  if (!record || typeof record.success !== "boolean") {
    return null;
  }
  return {
    success: record.success,
    name: asTrimmedString(record.name),
  };
}

function ensureServerState(
  byServer: Map<string, MutableServerState>,
  server: string,
): MutableServerState {
  const existing = byServer.get(server);
  if (existing) {
    return existing;
  }
  const next: MutableServerState = {
    server,
    statusState: "unknown",
    statusMessage: null,
    statusAt: null,
    warningMessage: null,
    remediationCommand: null,
    warningAt: null,
    oauthSuccessAt: null,
    authExpired: false,
  };
  byServer.set(server, next);
  return next;
}

function isAuthExpiredWarning(message: string, rawError: string | null): boolean {
  const lowerMessage = message.toLowerCase();
  const lowerError = rawError?.toLowerCase() ?? "";
  return (
    lowerMessage.includes("authentication expired") ||
    lowerMessage.includes("invalid refresh token") ||
    lowerError.includes("invalid_grant") ||
    lowerError.includes("invalid refresh token")
  );
}

function hasActiveWarning(server: MutableServerState): boolean {
  if (!server.warningAt) {
    return false;
  }
  if (!server.oauthSuccessAt) {
    return true;
  }
  return server.warningAt > server.oauthSuccessAt;
}

function serverDisplayState(server: MutableServerState): McpSessionServerState {
  if (hasActiveWarning(server)) {
    return "warning";
  }
  return server.statusState;
}

function serverLastEventAt(server: MutableServerState): string | null {
  if (hasActiveWarning(server)) {
    return server.warningAt;
  }
  return server.statusAt ?? server.oauthSuccessAt;
}

export function getMcpSessionStatusLabel(state: McpSessionServerState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "warning":
      return "Warning";
    case "unknown":
      return "Unknown";
  }
}

export function deriveMcpSessionViewModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): McpSessionViewModel {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const byServer = new Map<string, MutableServerState>();
  let hasAnyMcpActivity = false;

  for (const activity of ordered) {
    if (activity.kind === "mcp.status.updated") {
      const payload = parseMcpStatusUpdatedPayload(activity.payload);
      if (!payload) {
        continue;
      }
      hasAnyMcpActivity = true;
      const server = ensureServerState(byServer, normalizeMcpServerName(payload.server));
      server.statusState = payload.status.state;
      server.statusMessage = payload.status.error ?? null;
      server.statusAt = activity.createdAt;
      continue;
    }

    if (activity.kind === "runtime.warning") {
      const payload = asRecord(activity.payload);
      const message = asTrimmedString(payload?.message);
      const detail = parseMcpStartupWarningDetail(payload?.detail);
      if (!message || !detail) {
        continue;
      }
      hasAnyMcpActivity = true;
      const server = ensureServerState(byServer, detail.server);
      server.warningMessage = message;
      server.remediationCommand = detail.remediationCommand ?? null;
      server.warningAt = activity.createdAt;
      server.authExpired = isAuthExpiredWarning(message, detail.rawError ?? null);
      continue;
    }

    if (activity.kind === "mcp.oauth.completed") {
      const payload = parseOauthCompletedPayload(activity.payload);
      if (!payload || !payload.success || !payload.name) {
        continue;
      }
      hasAnyMcpActivity = true;
      const server = ensureServerState(byServer, payload.name);
      server.oauthSuccessAt = activity.createdAt;
      if (server.warningAt && server.warningAt <= activity.createdAt) {
        server.authExpired = false;
      }
      continue;
    }
  }

  const servers = [...byServer.values()]
    .map<McpSessionServerViewModel>((server) => {
      const state = serverDisplayState(server);
      return {
        server: server.server,
        displayName: humanizeMcpServerName(server.server),
        state,
        authExpired: server.authExpired && hasActiveWarning(server),
        message: state === "warning" ? server.warningMessage : server.statusMessage,
        remediationCommand:
          state === "warning" && hasActiveWarning(server) ? server.remediationCommand : null,
        lastEventAt: serverLastEventAt(server),
      };
    })
    .toSorted((left, right) => {
      const priorityDelta = STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state];
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return (
        left.displayName.localeCompare(right.displayName) || left.server.localeCompare(right.server)
      );
    });

  return { servers, hasAnyMcpActivity };
}
