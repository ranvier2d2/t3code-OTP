import { describe, expect, it } from "vitest";

import { deriveMcpSessionViewModel } from "./mcp-session-logic";

describe("deriveMcpSessionViewModel", () => {
  it("normalizes provider-specific MCP server names in status activities", () => {
    const result = deriveMcpSessionViewModel([
      {
        id: "activity-1" as never,
        tone: "info",
        kind: "mcp.status.updated",
        summary: "MCP server status updated",
        payload: {
          server: "claude.ai OpenAI Documentation",
          status: {
            state: "ready",
          },
        },
        turnId: null,
        createdAt: "2026-03-29T00:00:00.000Z",
      },
    ]);

    expect(result.servers).toEqual([
      {
        server: "openaiDeveloperDocs",
        displayName: "OpenAI Developer Docs",
        state: "ready",
        authExpired: false,
        message: null,
        remediationCommand: null,
        lastEventAt: "2026-03-29T00:00:00.000Z",
      },
    ]);
  });
});
