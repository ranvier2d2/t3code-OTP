/**
 * HarnessProvider — ServerProvider layers for Cursor and OpenCode.
 *
 * These providers query the Elixir harness for model discovery via
 * HarnessClientAdapter.listModels(), then feed into makeManagedServerProvider
 * for polling, settings-change detection, and PubSub streaming.
 *
 * @module HarnessProvider
 */
import type {
  HarnessProviderSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Stream } from "effect";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CursorProvider } from "../Services/HarnessProvider";
import { OpenCodeProvider } from "../Services/HarnessProvider";
import { HarnessClientAdapter } from "../Services/HarnessClientAdapter";
import { ServerSettingsService } from "../../serverSettings";
import { HARNESS_PROVIDER_CAPABILITIES } from "./HarnessClientAdapter";

function makeHarnessProviderLayer(provider: "cursor" | "opencode") {
  return Effect.gen(function* () {
    const harnessAdapter = yield* HarnessClientAdapter;
    const serverSettings = yield* ServerSettingsService;

    const getProviderSettings = serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          settings.providers[provider as "cursor" | "opencode"] as HarnessProviderSettings,
      ),
      Effect.orDie,
    );

    const checkProvider: Effect.Effect<ServerProvider> = Effect.gen(function* () {
      const settings = yield* getProviderSettings;
      const checkedAt = new Date().toISOString();

      if (!settings.enabled) {
        return buildServerProvider({
          provider,
          enabled: false,
          checkedAt,
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            authStatus: "unknown",
            message: `${provider} is disabled in T3 Code settings.`,
          },
        });
      }

      const harnessModels = yield* harnessAdapter.listModels(provider);
      const builtInModels: ServerProviderModel[] = harnessModels.map((m) => ({
        slug: m.slug,
        name: m.name,
        isCustom: false,
        capabilities: null,
      }));

      const models = providerModelsFromSettings(builtInModels, provider, settings.customModels);

      const capabilities = HARNESS_PROVIDER_CAPABILITIES[provider];

      return {
        ...buildServerProvider({
          provider,
          enabled: true,
          checkedAt,
          models,
          probe: {
            installed: true,
            version: null,
            status: "ready",
            authStatus: "unknown",
          },
        }),
        ...(capabilities ? { capabilities } : {}),
      } satisfies ServerProvider;
    }).pipe(Effect.orDie);

    return yield* makeManagedServerProvider<HarnessProviderSettings>({
      getSettings: getProviderSettings,
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map(
          (settings) =>
            settings.providers[provider as "cursor" | "opencode"] as HarnessProviderSettings,
        ),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  });
}

export const CursorProviderLive = Layer.effect(CursorProvider, makeHarnessProviderLayer("cursor"));

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  makeHarnessProviderLayer("opencode"),
);
