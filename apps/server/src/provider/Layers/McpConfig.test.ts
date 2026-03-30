import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type { ResolvedMcpConfig } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../config.ts";
import { McpConfigService, toPersistedMcpConfigRef } from "../Services/McpConfig.ts";
import { McpConfigServiceLive } from "./McpConfig.ts";

// ── Helpers ──────────────────────────────────────────────────────

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function makeTempContext() {
  const cwd = nodeFs.mkdtempSync(path.join(os.tmpdir(), "mcp-cwd-"));
  const baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "mcp-base-"));
  const stateDir = path.join(baseDir, "userdata");
  return { cwd, baseDir, stateDir };
}

function writeProjectConfig(cwd: string, config: unknown): void {
  nodeFs.mkdirSync(path.join(cwd, ".t3"), { recursive: true });
  nodeFs.writeFileSync(path.join(cwd, ".t3", "mcp.json"), JSON.stringify(config));
}

function writeGlobalConfig(stateDir: string, config: unknown): void {
  nodeFs.mkdirSync(path.join(stateDir, "mcp"), { recursive: true });
  nodeFs.writeFileSync(path.join(stateDir, "mcp", "global.json"), JSON.stringify(config));
}

function makeTestLayer(ctx: { cwd: string; baseDir: string }) {
  return McpConfigServiceLive.pipe(
    Layer.provide(ServerConfig.layerTest(ctx.cwd, ctx.baseDir)),
    Layer.provide(NodeServices.layer),
  );
}

// ── resolveConfig ────────────────────────────────────────────────

it.effect("resolveConfig reads project .t3/mcp.json", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    servers: {
      "file-server": {
        command: "node",
        args: ["serve.js"],
        transport: "stdio",
        enabled: true,
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0]!.name, "file-server");
    assert.equal(config.servers[0]!.transport, "stdio");
    assert.include(config.sourcePaths as string[], path.join(ctx.cwd, ".t3", "mcp.json"));
    assert.isString(config.version);
    assert.match(config.version as string, /^[a-f0-9]{16}$/);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig reads global config from stateDir", () => {
  const ctx = makeTempContext();
  writeGlobalConfig(ctx.stateDir, {
    servers: {
      "global-api": {
        url: "https://global.example.com",
        transport: "http",
        enabled: true,
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0]!.name, "global-api");
    assert.equal(config.servers[0]!.transport, "http");
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("project config overrides global config for same server name", () => {
  const ctx = makeTempContext();
  writeGlobalConfig(ctx.stateDir, {
    servers: {
      "shared-server": {
        command: "global-cmd",
        transport: "stdio",
        enabled: true,
      },
    },
  });
  writeProjectConfig(ctx.cwd, {
    servers: {
      "shared-server": {
        command: "project-cmd",
        args: ["--local"],
        transport: "stdio",
        enabled: true,
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    const server = config.servers[0]!;
    assert.equal(server.name, "shared-server");
    // Project config wins — global processed first, project overwrites.
    if (server.transport === "stdio") {
      assert.equal(server.command, "project-cmd");
    }
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig returns empty servers when no config files exist", () => {
  const ctx = makeTempContext();

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 0);
    assert.equal(config.sourcePaths.length, 0);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig normalizes mcpServers input key", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    mcpServers: {
      "alt-format": {
        command: "python",
        args: ["-m", "server"],
        transport: "stdio",
        enabled: true,
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0]!.name, "alt-format");
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig normalizes mcp key with array format", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    mcp: [{ name: "arr-server", command: "echo", transport: "stdio", enabled: true }],
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0]!.name, "arr-server");
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig normalizes transport type aliases", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    servers: {
      "local-tool": { type: "local", command: "python", args: ["-m", "tool"] },
      "remote-api": { type: "remote", url: "https://api.example.com" },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(config.servers.length, 2);
    const local = config.servers.find((s) => s.name === "local-tool");
    const remote = config.servers.find((s) => s.name === "remote-api");
    assert.equal(local?.transport, "stdio");
    assert.equal(remote?.transport, "http");
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("resolveConfig preserves remote headers and timeout", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    mcp: {
      Ref: {
        type: "remote",
        url: "https://api.ref.tools/mcp",
        headers: {
          "x-ref-api-key": "ref-123",
        },
        timeout: 2500,
        enabled: true,
      },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const config = yield* service.resolveConfig({ provider: "opencode", cwd: ctx.cwd });

    assert.equal(config.servers.length, 1);
    const remote = config.servers[0]!;
    assert.equal(remote.transport, "http");
    if (remote.transport !== "http" && remote.transport !== "sse") {
      assert.fail("expected remote MCP transport");
    }
    assert.deepEqual(remote.headers, { "x-ref-api-key": "ref-123" });
    assert.equal(remote.timeout, 2500);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

// ── Snapshots ────────────────────────────────────────────────────

it.effect("resolveConfig auto-persists snapshot when threadId is provided", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    servers: {
      "snap-server": { command: "echo", transport: "stdio", enabled: true },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const threadId = asThreadId("auto-persist-thread");

    const resolved = yield* service.resolveConfig({
      provider: "codex",
      cwd: ctx.cwd,
      threadId,
    });

    const snapshot = yield* service.getSnapshot(threadId);
    assert.isNotNull(snapshot);
    assert.equal(snapshot!.version, resolved.version);
    assert.equal(snapshot!.servers.length, 1);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("setSnapshot and getSnapshot round-trip preserves config", () => {
  const ctx = makeTempContext();

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const threadId = asThreadId("round-trip-thread");

    const config = {
      version: "abc12345def67890",
      resolvedAt: "2026-03-28T12:00:00.000Z",
      sourcePaths: ["/some/path/mcp.json"],
      servers: [
        {
          name: "snapshot-server",
          transport: "stdio" as const,
          command: "node",
          args: ["index.js"],
          enabled: true,
        },
      ],
    } as ResolvedMcpConfig;

    yield* service.setSnapshot(threadId, config);
    const retrieved = yield* service.getSnapshot(threadId);

    assert.isNotNull(retrieved);
    assert.equal(retrieved!.version, "abc12345def67890");
    assert.equal(retrieved!.servers.length, 1);
    assert.equal(retrieved!.servers[0]!.name, "snapshot-server");
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("clearSnapshot removes snapshot from cache and disk", () => {
  const ctx = makeTempContext();

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const threadId = asThreadId("clear-thread");

    const config = {
      version: "to-clear-00000000",
      resolvedAt: "2026-03-28T00:00:00.000Z",
      sourcePaths: [],
      servers: [],
    } as ResolvedMcpConfig;

    yield* service.setSnapshot(threadId, config);
    yield* service.clearSnapshot(threadId);

    const retrieved = yield* service.getSnapshot(threadId);
    assert.isNull(retrieved);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

it.effect("getSnapshot returns null for unknown threadId", () => {
  const ctx = makeTempContext();

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const result = yield* service.getSnapshot(asThreadId("nonexistent-thread"));
    assert.isNull(result);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

// ── Version ──────────────────────────────────────────────────────

it.effect("version hash is deterministic for same server config", () => {
  const ctx = makeTempContext();
  writeProjectConfig(ctx.cwd, {
    servers: {
      "stable-server": { command: "node", transport: "stdio", enabled: true },
    },
  });

  return Effect.gen(function* () {
    const service = yield* McpConfigService;
    const first = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });
    const second = yield* service.resolveConfig({ provider: "codex", cwd: ctx.cwd });

    assert.equal(first.version, second.version);
    assert.match(first.version as string, /^[a-f0-9]{16}$/);
  }).pipe(Effect.provide(makeTestLayer(ctx)));
});

// ── toPersistedMcpConfigRef ──────────────────────────────────────

it.effect("toPersistedMcpConfigRef returns undefined for empty config", () =>
  Effect.sync(() => {
    const config = {
      version: "empty-version-0000",
      resolvedAt: "2026-03-28T00:00:00.000Z",
      sourcePaths: [],
      servers: [],
    } as ResolvedMcpConfig;

    const ref = toPersistedMcpConfigRef(config);
    assert.isUndefined(ref);
  }),
);

it.effect("toPersistedMcpConfigRef extracts server count from resolved config", () =>
  Effect.sync(() => {
    const config = {
      version: "v123456789abcdef",
      resolvedAt: "2026-03-28T00:00:00.000Z",
      sourcePaths: ["/path/mcp.json"],
      servers: [
        { name: "a", transport: "stdio" as const, command: "cmd", enabled: true },
        { name: "b", transport: "http" as const, url: "http://x", enabled: true },
      ],
    } as ResolvedMcpConfig;

    const ref = toPersistedMcpConfigRef(config);
    assert.isDefined(ref);
    assert.equal(ref!.serverCount, 2);
    assert.equal(ref!.version, "v123456789abcdef");
    assert.deepEqual([...ref!.sourcePaths], ["/path/mcp.json"]);
  }),
);
