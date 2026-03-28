import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import type { ProviderKind } from "@t3tools/contracts";
import {
  ProviderAdapterProcessError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "./provider/Errors";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import {
  makeHarnessClientAdapterLive,
  HARNESS_PROVIDER_CAPABILITIES,
} from "./provider/Layers/HarnessClientAdapter";
import { HarnessClientAdapter } from "./provider/Services/HarnessClientAdapter";
import { ClaudeAdapter } from "./provider/Services/ClaudeAdapter";
import { CodexAdapter } from "./provider/Services/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { McpConfigServiceLive } from "./provider/Layers/McpConfig";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService } from "./provider/Services/ProviderService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import {
  ProviderRegistryLive,
  ProviderRegistryWithHarnessLive,
} from "./provider/Layers/ProviderRegistry";
import { ServerSettingsService } from "./serverSettings";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration";
import { PtyAdapter } from "./terminal/Services/PTY";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | Path.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: () => import("./terminal/Layers/BunPTY"),
  node: () => import("./terminal/Layers/NodePTY"),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime =
      process.versions.bun !== undefined && process.platform !== "win32" ? "bun" : "node";
    const loader = runtimePtyAdapterLoaders[runtime];
    const ptyAdapterModule = yield* Effect.promise<RuntimePtyAdapterLoader>(loader);
    return ptyAdapterModule.layer;
  }).pipe(Layer.unwrap);

/**
 * Provider layer: Claude always uses the Node SDK adapter (Agent SDK).
 * When the Elixir harness is available (harnessPort configured), Codex,
 * Cursor, and OpenCode are routed through it. Without harness, only
 * Claude and Codex (via Node SDK) are available.
 */
export function makeServerProviderLayer(options?: {
  harnessAdapterLayer?: ReturnType<typeof makeHarnessClientAdapterLive>;
}): Layer.Layer<
  ProviderService,
  ProviderUnsupportedError | ProviderAdapterProcessError,
  | SqlClient.SqlClient
  | ServerConfig
  | ServerSettingsService
  | FileSystem.FileSystem
  | AnalyticsService
> {
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const { providerEventLogPath } = serverConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );

    // Node SDK adapters — always available
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provideMerge(McpConfigServiceLive));
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );

    // Harness adapters — only when harnessPort is configured
    // Codex, Cursor, and OpenCode route through the Elixir harness.
    // Claude always uses the Node SDK adapter (Agent SDK, not CLI).
    const harnessEnabled = serverConfig.harnessPort !== undefined;
    const useLegacyCodex = process.env.T3CODE_CODEX_LEGACY === "1";
    const HARNESS_PROVIDERS = useLegacyCodex
      ? (["cursor", "opencode"] as const)
      : (["codex", "cursor", "opencode"] as const);

    // Determine the adapter registry layer based on configuration.
    //
    // Three paths:
    //   A) harnessPort configured — codex (unless legacy), cursor, opencode via harness
    //   B) legacy codex (T3CODE_CODEX_LEGACY=1) without harness — codex + claude only
    //   C) no harness port + harness required (default codex path) — error gracefully

    const harnessAdapterLayer = options?.harnessAdapterLayer ?? makeHarnessClientAdapterLive();

    const adapterRegistryLayer = harnessEnabled
      ? // Path A: harness available — route harness providers through it
        Layer.effect(
          ProviderAdapterRegistry,
          Effect.gen(function* () {
            const claudeAdapter = yield* ClaudeAdapter;
            const codexAdapter = yield* CodexAdapter;
            const harnessBaseAdapter = yield* HarnessClientAdapter;

            type Adapter = ProviderAdapterShape<ProviderAdapterError>;
            const byProvider = new Map<string, Adapter>();

            byProvider.set("claudeAgent", claudeAdapter);
            if (useLegacyCodex) {
              byProvider.set("codex", codexAdapter);
            }

            for (const providerKind of HARNESS_PROVIDERS) {
              byProvider.set(providerKind, {
                ...harnessBaseAdapter,
                provider: providerKind,
                capabilities:
                  HARNESS_PROVIDER_CAPABILITIES[providerKind] ?? harnessBaseAdapter.capabilities,
              } as Adapter);
            }

            return {
              getByProvider: (provider) => {
                const adapter = byProvider.get(provider);
                if (!adapter) {
                  return Effect.fail(new ProviderUnsupportedError({ provider }));
                }
                return Effect.succeed(adapter);
              },
              listProviders: () =>
                Effect.sync(
                  () => Array.from(byProvider.keys()) as unknown as readonly ProviderKind[],
                ),
            };
          }),
        ).pipe(
          Layer.provide(codexAdapterLayer),
          Layer.provide(claudeAdapterLayer),
          Layer.provideMerge(harnessAdapterLayer.pipe(Layer.provideMerge(McpConfigServiceLive))),
          Layer.provideMerge(providerSessionDirectoryLayer),
        )
      : useLegacyCodex
        ? // Path B: legacy codex, no harness — codex + claude only
          ProviderAdapterRegistryLive.pipe(
            Layer.provide(codexAdapterLayer),
            Layer.provide(claudeAdapterLayer),
            Layer.provideMerge(providerSessionDirectoryLayer),
          )
        : // Path C: harness required but not configured — error gracefully
          Layer.effect(
            ProviderAdapterRegistry,
            Effect.gen(function* () {
              yield* Effect.logError(
                "[codex-harness-cutover] Harness port is not configured but Codex requires " +
                  "the harness (default path). Set T3CODE_CODEX_LEGACY=1 to use the legacy " +
                  "direct adapter, or configure harnessPort.",
              );
              const claudeAdapter = yield* ClaudeAdapter;
              type Adapter = ProviderAdapterShape<ProviderAdapterError>;
              const byProvider = new Map<string, Adapter>();
              byProvider.set("claudeAgent", claudeAdapter);

              return {
                getByProvider: (provider: string) => {
                  const adapter = byProvider.get(provider);
                  if (!adapter) {
                    return Effect.fail(
                      new ProviderUnsupportedError({
                        provider,
                        ...(provider === "codex" || provider === "cursor" || provider === "opencode"
                          ? {
                              cause: new Error(
                                `Harness port is not configured. Provider '${provider}' requires the Elixir harness. ` +
                                  `Set T3CODE_CODEX_LEGACY=1 to use the legacy direct adapter, or configure harnessPort.`,
                              ),
                            }
                          : {}),
                      }),
                    );
                  }
                  return Effect.succeed(adapter);
                },
                listProviders: () =>
                  Effect.sync(
                    () => Array.from(byProvider.keys()) as unknown as readonly ProviderKind[],
                  ),
              };
            }),
          ).pipe(
            Layer.provide(claudeAdapterLayer),
            Layer.provideMerge(providerSessionDirectoryLayer),
          );

    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(McpConfigServiceLive),
    );
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeServicesLayer() {
  const textGenerationLayer = RoutingTextGenerationLive;
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(checkpointStoreLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(textGenerationLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );

  const terminalLayer = TerminalManagerLive.pipe(Layer.provide(makeRuntimePtyAdapterLayer()));

  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(GitHubCliLive),
    Layer.provideMerge(textGenerationLayer),
  );

  return Layer.mergeAll(
    orchestrationReactorLayer,
    GitCoreLive,
    gitManagerLayer,
    terminalLayer,
    KeybindingsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

/**
 * Returns the appropriate ProviderRegistry layer depending on whether the
 * Elixir harness is available (harnessPort in ServerConfig).
 *
 * When harness is enabled, Cursor and OpenCode model discovery is included.
 */
export function makeProviderRegistryLayer(options?: {
  harnessAdapterLayer?: ReturnType<typeof makeHarnessClientAdapterLive>;
}) {
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const harnessEnabled = serverConfig.harnessPort !== undefined;
    if (harnessEnabled) {
      return ProviderRegistryWithHarnessLive.pipe(
        Layer.provide(
          (options?.harnessAdapterLayer ?? makeHarnessClientAdapterLive()).pipe(
            Layer.provideMerge(McpConfigServiceLive),
          ),
        ),
      );
    }
    return ProviderRegistryLive;
  }).pipe(Layer.unwrap);
}
