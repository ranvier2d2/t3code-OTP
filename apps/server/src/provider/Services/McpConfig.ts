import type {
  PersistedMcpConfigRef,
  ProviderKind,
  ResolvedMcpConfig,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

export class McpConfigError extends Schema.TaggedErrorClass<McpConfigError>()("McpConfigError", {
  operation: Schema.String,
  detail: Schema.String,
  cwd: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export interface McpConfigServiceShape {
  readonly resolveConfig: (input: {
    readonly provider: ProviderKind;
    readonly cwd: string;
    readonly threadId?: ThreadId;
  }) => Effect.Effect<ResolvedMcpConfig, McpConfigError>;
  readonly setSnapshot: (threadId: ThreadId, config: ResolvedMcpConfig) => Effect.Effect<void>;
  readonly getSnapshot: (threadId: ThreadId) => Effect.Effect<ResolvedMcpConfig | null>;
  readonly clearSnapshot: (threadId: ThreadId) => Effect.Effect<void>;
}

export class McpConfigService extends ServiceMap.Service<McpConfigService, McpConfigServiceShape>()(
  "t3/provider/Services/McpConfig/McpConfigService",
) {
  static readonly layerTest = (options?: {
    readonly resolveConfig?: McpConfigServiceShape["resolveConfig"];
    readonly setSnapshot?: McpConfigServiceShape["setSnapshot"];
    readonly getSnapshot?: McpConfigServiceShape["getSnapshot"];
    readonly clearSnapshot?: McpConfigServiceShape["clearSnapshot"];
  }) =>
    Layer.succeed(McpConfigService, {
      resolveConfig:
        options?.resolveConfig ??
        (() =>
          Effect.succeed({
            version: "empty",
            resolvedAt: new Date(0).toISOString(),
            sourcePaths: [],
            servers: [],
          })),
      setSnapshot: options?.setSnapshot ?? (() => Effect.void),
      getSnapshot: options?.getSnapshot ?? (() => Effect.succeed(null)),
      clearSnapshot: options?.clearSnapshot ?? (() => Effect.void),
    } satisfies McpConfigServiceShape);
}

export function toPersistedMcpConfigRef(
  config: ResolvedMcpConfig,
): PersistedMcpConfigRef | undefined {
  if (config.servers.length === 0 && config.sourcePaths.length === 0) {
    return undefined;
  }
  return {
    version: config.version,
    resolvedAt: config.resolvedAt,
    sourcePaths: config.sourcePaths,
    serverCount: config.servers.length,
  };
}
