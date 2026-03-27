/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Schedule, Stream } from "effect";

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
  models: ReadonlyArray<{ slug: string; name: string }>,
): ServerProvider {
  return {
    provider,
    enabled,
    installed: true,
    version: null,
    status: enabled ? "ready" : "disabled",
    authStatus: "authenticated" as const,
    checkedAt: new Date().toISOString(),
    models: models.map(
      (m): ServerProviderModel => ({
        slug: m.slug,
        name: m.name,
        isCustom: false,
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
    const harnessAdapter = yield* HarnessClientAdapter;
    const settingsService = yield* ServerSettingsService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    /** Query the harness for model lists and build snapshots for harness-routed providers. */
    const loadHarnessProviders = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const snapshots: ServerProvider[] = [];
      for (const provider of HARNESS_PROVIDERS) {
        const enabled = settings?.providers[provider]?.enabled ?? true;
        const models = yield* Effect.tryPromise({
          try: () => harnessAdapter.listProviderModels(provider),
          catch: () => [] as ReadonlyArray<{ slug: string; name: string }>,
        }).pipe(Effect.orElseSucceed(() => []));
        // Merge custom models from settings
        const customModels = settings?.providers[provider]?.customModels ?? [];
        const seen = new Set(models.map((m) => m.slug));
        const allModels = [
          ...models,
          ...customModels
            .filter((slug: string) => !seen.has(slug))
            .map((slug: string) => ({ slug, name: slug })),
        ];
        snapshots.push(buildHarnessProviderSnapshot(provider, enabled, allModels));
      }
      return snapshots;
    }).pipe(Effect.orElseSucceed(() => [] as ServerProvider[]));

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
    yield* syncProviders()
      .pipe(
        Effect.delay("60 seconds"),
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.orElseSucceed(() => undefined),
      )
      .pipe(Effect.forkScoped);

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
