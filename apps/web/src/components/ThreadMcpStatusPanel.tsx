import { useEffect, useMemo, useState } from "react";
import { LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import type { McpSessionServerViewModel, McpSessionViewModel } from "../mcp-session-logic";
import { getMcpSessionStatusLabel } from "../mcp-session-logic";
import { humanizeMcpServerName, normalizeMcpServerName } from "@t3tools/shared/mcp";
import { ensureNativeApi } from "../nativeApi";
import { cn } from "~/lib/utils";

function badgeVariantForState(state: McpSessionServerViewModel["state"]) {
  switch (state) {
    case "ready":
      return "success";
    case "failed":
      return "error";
    case "warning":
    case "cancelled":
      return "warning";
    case "starting":
      return "info";
    case "unknown":
    default:
      return "outline";
  }
}

function convertFetchedStatus(data: Record<string, unknown>): McpSessionServerViewModel[] {
  const servers: McpSessionServerViewModel[] = [];
  for (const [name, raw] of Object.entries(data)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const status = typeof entry.status === "string" ? entry.status : "unknown";

    let state: McpSessionServerViewModel["state"];
    switch (status) {
      case "connected":
        state = "ready";
        break;
      case "disabled":
        state = "cancelled";
        break;
      case "failed":
      case "needs_client_registration":
        state = "failed";
        break;
      case "needs_auth":
        state = "warning";
        break;
      default:
        state = "unknown";
    }

    const normalizedName = normalizeMcpServerName(name);
    servers.push({
      server: normalizedName,
      displayName: humanizeMcpServerName(normalizedName),
      state,
      authExpired: status === "needs_auth",
      message: typeof entry.error === "string" ? entry.error : null,
      remediationCommand: null,
      lastEventAt: null,
    });
  }
  return servers;
}

function mergeServers(
  eventServers: readonly McpSessionServerViewModel[],
  fetchedServers: readonly McpSessionServerViewModel[],
): McpSessionServerViewModel[] {
  const byName = new Map<string, McpSessionServerViewModel>();
  // Fetched data is the baseline
  for (const server of fetchedServers) {
    byName.set(server.server, server);
  }
  // Event-derived data overwrites (more recent)
  for (const server of eventServers) {
    byName.set(server.server, server);
  }
  return [...byName.values()];
}

type RefreshState = "refreshing" | "ready" | "error";

export default function ThreadMcpStatusPanel({
  threadId,
  mcp,
  onClose,
  className,
}: {
  threadId: string;
  mcp: McpSessionViewModel;
  onClose?: () => void;
  className?: string;
}) {
  const [fetchedServers, setFetchedServers] = useState<McpSessionServerViewModel[]>([]);
  const [refreshState, setRefreshState] = useState<RefreshState>("refreshing");

  useEffect(() => {
    let cancelled = false;
    setRefreshState("refreshing");
    ensureNativeApi()
      .mcp.status(threadId)
      .then((data) => {
        if (cancelled) return;
        setFetchedServers(convertFetchedStatus(data));
        setRefreshState("ready");
      })
      .catch(() => {
        if (!cancelled) {
          // Provider doesn't support MCP status — fall back to runtime events only.
          setRefreshState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const servers = useMemo(
    () => mergeServers(mcp.servers, fetchedServers),
    [mcp.servers, fetchedServers],
  );
  const showEmptyState = servers.length === 0;
  const showBackgroundRefresh = refreshState === "refreshing";
  const showRefreshFallback = refreshState === "error";

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="gap-1 p-4 pb-3">
        <CardTitle className="text-base">MCP status</CardTitle>
        <CardDescription>Runtime MCP state for the active thread session.</CardDescription>
        {onClose ? (
          <CardAction>
            <Button
              type="button"
              aria-label="Hide MCP status"
              size="icon-xs"
              variant="ghost"
              onClick={onClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="min-h-0 space-y-3 overflow-y-auto p-4 pt-0">
        {showBackgroundRefresh ? (
          <div className="flex items-center justify-between rounded-xl border border-border/80 bg-muted/15 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              <span>Refreshing live MCP status</span>
            </div>
            <Badge variant="outline" size="sm">
              Background sync
            </Badge>
          </div>
        ) : null}
        {showRefreshFallback ? (
          <div className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TriangleAlertIcon className="size-4 text-amber-500" />
              <span>Live refresh unavailable. Showing runtime activity only.</span>
            </div>
            <RefreshCwIcon className="size-4 text-muted-foreground/70" />
          </div>
        ) : null}
        {showEmptyState ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No MCP servers detected for this session.
          </p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <div
                key={server.server}
                className="rounded-xl border border-border/80 bg-muted/12 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{server.displayName}</h3>
                      {server.authExpired ? (
                        <Badge variant="warning" size="sm">
                          Auth expired
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Badge variant={badgeVariantForState(server.state)}>
                    {getMcpSessionStatusLabel(server.state)}
                  </Badge>
                </div>
                {server.message ? (
                  <p className="mt-2.5 text-sm text-muted-foreground" title={server.message}>
                    {server.message}
                  </p>
                ) : null}
                {server.remediationCommand ? (
                  <code className="mt-2.5 block overflow-x-auto rounded-md border border-border/80 bg-background px-2.5 py-2 text-xs text-foreground">
                    {server.remediationCommand}
                  </code>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
