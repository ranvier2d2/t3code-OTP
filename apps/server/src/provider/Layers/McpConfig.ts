import { createHash } from "node:crypto";
import path from "node:path";

import {
  McpServerConfig,
  ResolvedMcpConfig,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  McpConfigError,
  McpConfigService,
  type McpConfigServiceShape,
} from "../Services/McpConfig.ts";

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string");
  if (entries.length !== Object.keys(value).length) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizeTransport(value: RawRecord): "stdio" | "http" | "sse" {
  const explicit = asString(value.transport);
  if (explicit === "stdio" || explicit === "http" || explicit === "sse") {
    return explicit;
  }
  const type = asString(value.type);
  if (type === "stdio" || type === "local") return "stdio";
  if (type === "sse") return "sse";
  if (type === "http" || type === "remote") return "http";
  return typeof value.url === "string" ? "http" : "stdio";
}

function normalizeServer(name: string, rawValue: unknown): McpServerConfig | undefined {
  const raw = isRecord(rawValue) ? rawValue : undefined;
  if (!raw) return undefined;
  const normalizedName = name.trim();
  if (normalizedName.length === 0) return undefined;

  const transport = normalizeTransport(raw);
  const command = asString(raw.command)?.trim();
  const args = asStringArray(raw.args);
  const env = asStringRecord(raw.env);
  const url = asString(raw.url)?.trim();
  const enabled = raw.enabled !== false;

  if (transport === "stdio" && !command) {
    return undefined;
  }
  if (transport !== "stdio" && !url) {
    return undefined;
  }

  if (transport === "stdio") {
    return {
      name: normalizedName,
      transport,
      command: command!,
      ...(args ? { args: [...args] } : {}),
      ...(env ? { env } : {}),
      enabled,
    };
  }

  return {
    name: normalizedName,
    transport,
    url: url!,
    ...(env ? { env } : {}),
    enabled,
  };
}

function readServerEntries(raw: unknown): ReadonlyArray<[string, unknown]> {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => {
      const record = isRecord(entry) ? entry : undefined;
      const name = record ? asString(record.name) : undefined;
      return name ? [[name, entry] as const] : [];
    });
  }
  if (isRecord(raw)) {
    return Object.entries(raw);
  }
  return [];
}

function normalizeConfigEntries(raw: unknown): ReadonlyArray<[string, unknown]> {
  if (!isRecord(raw)) return [];

  if ("servers" in raw) {
    return readServerEntries(raw.servers);
  }
  if ("mcpServers" in raw) {
    return readServerEntries(raw.mcpServers);
  }
  if ("mcp" in raw) {
    return readServerEntries(raw.mcp);
  }

  return [];
}

function versionForServers(servers: ReadonlyArray<McpServerConfig>): string {
  const normalized = servers
    .map((server) => ({
      ...server,
      args: "args" in server && server.args ? [...server.args] : [],
      env: server.env
        ? Object.fromEntries(
            Object.entries(server.env).toSorted(([left], [right]) => left.localeCompare(right)),
          )
        : {},
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

function snapshotPath(stateDir: string, threadId: ThreadId): string {
  const snapshotId = createHash("sha256").update(String(threadId)).digest("hex");
  return path.join(stateDir, "mcp", "snapshots", `${snapshotId}.json`);
}

const makeMcpConfigService = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const snapshotsRef = yield* Ref.make(new Map<ThreadId, ResolvedMcpConfig>());

  const cacheSnapshot = (threadId: ThreadId, config: ResolvedMcpConfig) =>
    Ref.update(snapshotsRef, (current) => {
      const next = new Map(current);
      next.set(threadId, config);
      return next;
    });

  const persistSnapshot = (threadId: ThreadId, config: ResolvedMcpConfig) =>
    Effect.gen(function* () {
      const targetPath = snapshotPath(serverConfig.stateDir, threadId);
      yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new McpConfigError({
              operation: "McpConfigService.persistSnapshot",
              detail: `Failed to create MCP snapshot directory for '${targetPath}'.`,
              cwd: targetPath,
              cause,
            }),
        ),
      );
      yield* fileSystem.writeFileString(targetPath, `${JSON.stringify(config, null, 2)}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new McpConfigError({
              operation: "McpConfigService.persistSnapshot",
              detail: `Failed to write MCP snapshot '${targetPath}'.`,
              cwd: targetPath,
              cause,
            }),
        ),
      );
      yield* cacheSnapshot(threadId, config);
    });

  const loadSnapshot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const targetPath = snapshotPath(serverConfig.stateDir, threadId);
      const exists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return null;

      const raw = yield* fileSystem
        .readFileString(targetPath)
        .pipe(Effect.catch(() => Effect.succeed<string | null>(null)));
      if (raw === null) return null;

      const parsed = (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      })();
      if (parsed === null || !Schema.is(ResolvedMcpConfig)(parsed)) {
        return null;
      }

      yield* cacheSnapshot(threadId, parsed);
      return parsed;
    });

  const readConfigFile = (configPath: string) =>
    fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new McpConfigError({
            operation: "McpConfigService.readConfigFile",
            detail: `Failed to read MCP config '${configPath}'.`,
            cwd: configPath,
            cause,
          }),
      ),
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (cause) =>
            new McpConfigError({
              operation: "McpConfigService.readConfigFile",
              detail: `Invalid JSON in MCP config '${configPath}'.`,
              cwd: configPath,
              cause,
            }),
        }),
      ),
    );

  const resolveConfig = ({
    provider,
    cwd,
    threadId,
  }: {
    readonly provider: ProviderKind;
    readonly cwd: string;
    readonly threadId?: ThreadId;
  }) =>
    Effect.gen(function* () {
      const projectConfigPath = path.join(cwd, ".t3", "mcp.json");
      const globalConfigPath = path.join(serverConfig.stateDir, "mcp", "global.json");
      const candidatePaths = [globalConfigPath, projectConfigPath];

      const serversByName = new Map<string, McpServerConfig>();
      const sourcePaths: Array<string> = [];

      for (const candidatePath of candidatePaths) {
        const exists = yield* fileSystem
          .exists(candidatePath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const rawConfig = yield* readConfigFile(candidatePath);
        const entries = normalizeConfigEntries(rawConfig);
        if (entries.length === 0) continue;
        sourcePaths.push(candidatePath);
        for (const [name, rawEntry] of entries) {
          const normalized = normalizeServer(name, rawEntry);
          if (normalized) {
            serversByName.set(normalized.name, normalized);
          }
        }
      }

      const servers = Array.from(serversByName.values());
      const resolvedAt = new Date().toISOString();
      const resolved: ResolvedMcpConfig = {
        version: versionForServers(servers),
        resolvedAt,
        sourcePaths,
        servers,
      };

      if (threadId) {
        yield* persistSnapshot(threadId, resolved);
      }

      yield* Effect.logDebug("resolved MCP configuration", {
        provider,
        cwd,
        threadId: threadId ?? null,
        sourcePaths,
        serverCount: servers.length,
        version: resolved.version,
      });

      return resolved;
    });

  const getSnapshot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshots = yield* Ref.get(snapshotsRef);
      const inMemory = snapshots.get(threadId);
      if (inMemory) return inMemory;
      return yield* loadSnapshot(threadId);
    });

  const setSnapshot = (threadId: ThreadId, config: ResolvedMcpConfig) =>
    persistSnapshot(threadId, config).pipe(Effect.catch(() => cacheSnapshot(threadId, config)));

  const clearSnapshot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const targetPath = snapshotPath(serverConfig.stateDir, threadId);
      yield* Ref.update(snapshotsRef, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
      const exists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        yield* fileSystem.remove(targetPath).pipe(Effect.catch(() => Effect.void));
      }
    });

  return {
    resolveConfig,
    setSnapshot,
    getSnapshot,
    clearSnapshot,
  } satisfies McpConfigServiceShape;
});

export const McpConfigServiceLive = Layer.effect(McpConfigService, makeMcpConfigService);
