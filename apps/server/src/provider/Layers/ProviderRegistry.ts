/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive, OpenCodeProviderLive } from "./HarnessProvider";
import { HARNESS_PROVIDER_CAPABILITIES } from "../providerCapabilities.ts";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape, OpenCodeProviderShape } from "../Services/HarnessProvider";
import { CursorProvider, OpenCodeProvider } from "../Services/HarnessProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import type { ServerProviderShape } from "../Services/ServerProvider";

const loadProviders = (
  providers: ReadonlyArray<ServerProviderShape>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.all(
    providers.map((p) => p.getSnapshot),
    { concurrency: "unbounded" },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

function makeProviderRegistryEffect(
  providers: ReadonlyArray<ServerProviderShape>,
  refreshByKind: Record<string, ServerProviderShape>,
) {
  return Effect.gen(function* () {
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(providers),
    );

    const syncProviders = (options?: { readonly publish?: boolean }) =>
      Effect.gen(function* () {
        const previousProviders = yield* Ref.get(providersRef);
        const nextProviders = yield* loadProviders(providers);
        yield* Ref.set(providersRef, nextProviders);

        if (options?.publish !== false && haveProvidersChanged(previousProviders, nextProviders)) {
          yield* PubSub.publish(changesPubSub, nextProviders);
        }

        return nextProviders;
      });

    for (const provider of providers) {
      yield* Stream.runForEach(provider.streamChanges, () => syncProviders()).pipe(
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
          if (provider && refreshByKind[provider]) {
            yield* refreshByKind[provider].refresh;
          } else {
            yield* Effect.all(
              providers.map((p) => p.refresh),
              { concurrency: "unbounded" },
            );
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
  });
}

/** Registry with Codex + Claude only (harness disabled). */
export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    return yield* makeProviderRegistryEffect([codexProvider, claudeProvider], {
      codex: codexProvider,
      claudeAgent: claudeProvider,
    });
  }),
).pipe(Layer.provideMerge(CodexProviderLive), Layer.provideMerge(ClaudeProviderLive));

/** Registry with all 4 providers (harness enabled). */
export const ProviderRegistryWithHarnessLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProviderBase: CodexProviderShape = yield* CodexProvider;
    const codexProvider: CodexProviderShape = {
      getSnapshot: codexProviderBase.getSnapshot.pipe(
        Effect.map((provider) => ({
          ...provider,
          capabilities: HARNESS_PROVIDER_CAPABILITIES.codex,
        })),
      ),
      refresh: codexProviderBase.refresh.pipe(
        Effect.map((provider) => ({
          ...provider,
          capabilities: HARNESS_PROVIDER_CAPABILITIES.codex,
        })),
      ),
      streamChanges: codexProviderBase.streamChanges.pipe(
        Stream.map((provider) => ({
          ...provider,
          capabilities: HARNESS_PROVIDER_CAPABILITIES.codex,
        })),
      ),
    };
    const claudeProvider: ClaudeProviderShape = yield* ClaudeProvider;
    const cursorProvider: CursorProviderShape = yield* CursorProvider;
    const openCodeProvider: OpenCodeProviderShape = yield* OpenCodeProvider;
    return yield* makeProviderRegistryEffect(
      [codexProvider, claudeProvider, cursorProvider, openCodeProvider],
      {
        codex: codexProvider,
        claudeAgent: claudeProvider,
        cursor: cursorProvider,
        opencode: openCodeProvider,
      },
    );
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(OpenCodeProviderLive),
);
