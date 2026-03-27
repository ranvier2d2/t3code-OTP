/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, PubSub, Ref, Result, Schedule, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import { HarnessClientAdapter } from "../Services/HarnessClientAdapter";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import { ServerSettingsService } from "../../serverSettings";

/** Harness-routed providers whose models are discovered via the Elixir harness. */
const HARNESS_PROVIDERS = ["cursor", "opencode"] as const satisfies readonly ProviderKind[];

const loadNodeProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider]> =>
  Effect.all([codexProvider.getSnapshot, claudeProvider.getSnapshot], {
    concurrency: "unbounded",
  });

/** Build a ServerProvider snapshot for a harness-routed provider using discovered models. */
function buildHarnessProviderSnapshot(
  provider: ProviderKind,
  enabled: boolean,
  models: ReadonlyArray<{ slug: string; name: string; isCustom?: boolean }>,
  reachable: boolean,
): ServerProvider {
  return {
    provider,
    enabled,
    installed: reachable,
    version: null,
    status: !enabled ? "disabled" : reachable ? "ready" : "warning",
    authStatus: reachable ? ("authenticated" as const) : ("unknown" as const),
    checkedAt: new Date().toISOString(),
    ...(reachable ? {} : { message: `Could not reach harness for ${provider} model discovery.` }),
    models: models.map(
      (m): ServerProviderModel => ({
        slug: m.slug,
        name: m.name,
        isCustom: Boolean(m.isCustom),
        capabilities: null,
      }),
    ),
  };
}

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const harnessAdapterOption = yield* Effect.serviceOption(HarnessClientAdapter);
    const settingsService = yield* ServerSettingsService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    /** Query the harness for model lists and build snapshots for harness-routed providers. */
    const loadHarnessProviders = Option.match(harnessAdapterOption, {
      onNone: () => Effect.succeed([] as ServerProvider[]),
      onSome: (harnessAdapter) =>
        Effect.gen(function* () {
          const settings = yield* settingsService.getSettings.pipe(
            Effect.orElseSucceed(() => null),
          );
          const snapshots: ServerProvider[] = [];
          for (const provider of HARNESS_PROVIDERS) {
            const enabled = settings?.providers[provider]?.enabled ?? true;
            const discoveredModels = yield* Effect.tryPromise({
              try: () => harnessAdapter.listProviderModels(provider),
              catch: (cause) => ({
                _tag: "HarnessModelDiscoveryError" as const,
                provider,
                cause,
              }),
            }).pipe(Effect.result);
            const reachable =
              Result.isSuccess(discoveredModels) && discoveredModels.success.length > 0;
            const models: ReadonlyArray<{ slug: string; name: string }> = Result.isSuccess(
              discoveredModels,
            )
              ? discoveredModels.success
              : [];
            // Merge custom models from settings
            const customModels = settings?.providers[provider]?.customModels ?? [];
            const seen = new Set(models.map((m) => m.slug));
            const allModels = [
              ...models,
              ...customModels
                .filter((slug: string) => !seen.has(slug))
                .map((slug: string) => ({ slug, name: slug, isCustom: true as const })),
            ];
            snapshots.push(buildHarnessProviderSnapshot(provider, enabled, allModels, reachable));
          }
          return snapshots;
        }).pipe(Effect.orElseSucceed(() => [] as ServerProvider[])),
    });

    /** Load all providers (Node-discovered + harness-discovered). */
    const loadAllProviders = Effect.gen(function* () {
      const [nodeProviders, harnessProviders] = yield* Effect.all(
        [loadNodeProviders(codexProvider, claudeProvider), loadHarnessProviders],
        { concurrency: "unbounded" },
      );
      return [...nodeProviders, ...harnessProviders] as ReadonlyArray<ServerProvider>;
    });

    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(yield* loadAllProviders);

    const syncProviders = (options?: { readonly publish?: boolean }) =>
      Effect.gen(function* () {
        const previousProviders = yield* Ref.get(providersRef);
        const providers = yield* loadAllProviders;
        yield* Ref.set(providersRef, providers);

        if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }

        return providers;
      });

    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    // Periodically refresh harness provider models (every 60s).
    // Harness providers don't have a change stream, so we poll.
    // Error handling is inside the repeated effect so one failure doesn't kill the schedule.
    if (Option.isSome(harnessAdapterOption)) {
      yield* syncProviders().pipe(
        Effect.orElseSucceed(() => undefined as unknown),
        Effect.delay("60 seconds"),
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.forkScoped,
      );
    }

    return {
      getProviders: syncProviders({ publish: false }).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
      refresh: (provider?: ProviderKind) =>
        Effect.gen(function* () {
          switch (provider) {
            case "codex":
              yield* codexProvider.refresh;
              break;
            case "claudeAgent":
              yield* claudeProvider.refresh;
              break;
            case "cursor":
            case "opencode":
              // Harness providers refresh via loadHarnessProviders in syncProviders
              break;
            default:
              yield* Effect.all([codexProvider.refresh, claudeProvider.refresh], {
                concurrency: "unbounded",
              });
              break;
          }
          return yield* syncProviders();
        }).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(Layer.provideMerge(CodexProviderLive), Layer.provideMerge(ClaudeProviderLive));
