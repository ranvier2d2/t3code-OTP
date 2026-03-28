import type { ProviderKind, ProviderRuntimeEvent } from "@t3tools/contracts";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterValidationError,
  ProviderUnsupportedError,
} from "../src/provider/Errors.ts";
import { McpConfigService } from "../src/provider/Services/McpConfig.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderSessionRuntimeRepository } from "../src/persistence/Services/ProviderSessionRuntime.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import { codexTurnTextFixture } from "./fixtures/providerRuntime.ts";

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService | ProviderSessionRuntimeRepository, unknown, never>;
  readonly analyticsEvents: Array<{
    readonly event: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  }>;
}

const makeIntegrationFixture = (provider: ProviderKind) =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness({ provider });

    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (candidate) =>
        candidate === provider
          ? Effect.succeed(harness.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider: candidate })),
      listProviders: () => Effect.succeed([provider]),
    };

    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const analyticsEvents: Array<{
      readonly event: string;
      readonly properties?: Readonly<Record<string, unknown>>;
    }> = [];

    const shared = Layer.mergeAll(
      runtimeRepositoryLayer,
      directoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
      Layer.succeed(AnalyticsService, {
        record: (event: string, properties?: Readonly<Record<string, unknown>>) =>
          Effect.sync(() => {
            analyticsEvents.push({ event, ...(properties ? { properties } : {}) });
          }),
        flush: Effect.void,
      }),
      McpConfigService.layerTest({
        resolveConfig: () =>
          Effect.succeed({
            version: "mcp-v1",
            resolvedAt: "2026-01-01T00:00:00.000Z",
            sourcePaths: ["/workspace/.t3/mcp.json"],
            servers: [
              {
                name: "playwright",
                transport: "stdio",
                command: "npx",
                args: ["@playwright/mcp@latest"],
                enabled: true,
              },
            ],
          }),
      }),
    );

    return {
      cwd,
      harness,
      layer: Layer.merge(shared, makeProviderServiceLive().pipe(Layer.provide(shared))),
      analyticsEvents,
    } satisfies IntegrationFixture;
  });

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const queueTextTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly response?: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(
      input.threadId,
      input.response ?? { events: codexTurnTextFixture },
    );

    return yield* collectEventsDuring(
      input.provider.streamEvents,
      (input.response ?? { events: codexTurnTextFixture }).events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.text,
        attachments: [],
      }),
    );
  });

const PROVIDERS: ReadonlyArray<ProviderKind> = ["codex", "claudeAgent", "cursor", "opencode"];

for (const providerKind of PROVIDERS) {
  it.effect(
    `provider contract: ${providerKind} starts, reports capabilities, and replays a turn`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeIntegrationFixture(providerKind);

        yield* Effect.gen(function* () {
          const providerService = yield* ProviderService;
          const threadId = ThreadId.makeUnsafe(`thread-contract-${providerKind}`);
          const session = yield* providerService.startSession(threadId, {
            threadId,
            provider: providerKind,
            cwd: fixture.cwd,
            runtimeMode: "full-access",
          });
          assert.equal(session.provider, providerKind);

          const listed = yield* providerService.listSessions();
          assert.equal(listed.length, 1);
          assert.equal(listed[0]?.provider, providerKind);

          const capabilities = yield* providerService.getCapabilities(providerKind);
          assert.deepEqual(capabilities, fixture.harness.adapter.capabilities);

          const observedEvents = yield* queueTextTurn({
            provider: providerService,
            harness: fixture.harness,
            threadId,
            text: `hello from ${providerKind}`,
          });
          assert.equal(observedEvents.length > 0, true);

          const snapshot = yield* fixture.harness.adapter.readThread(threadId);
          assert.equal(snapshot.turns.length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`provider contract: ${providerKind} enforces rollback capability`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeIntegrationFixture(providerKind);

      yield* Effect.gen(function* () {
        const providerService = yield* ProviderService;
        const threadId = ThreadId.makeUnsafe(`thread-rollback-${providerKind}`);
        yield* providerService.startSession(threadId, {
          threadId,
          provider: providerKind,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        yield* queueTextTurn({
          provider: providerService,
          harness: fixture.harness,
          threadId,
          text: "rollback me",
        });

        const capabilities = yield* providerService.getCapabilities(providerKind);
        const rollbackResult = yield* Effect.exit(
          providerService.rollbackConversation({ threadId, numTurns: 1 }),
        );

        if (capabilities.supportsRollback) {
          assert.equal(Exit.isSuccess(rollbackResult), true);
          assert.deepEqual(fixture.harness.getRollbackCalls(threadId), [1]);
        } else {
          assert.equal(Exit.isFailure(rollbackResult), true);
          if (Exit.isFailure(rollbackResult)) {
            assert.equal(
              Schema.is(ProviderAdapterValidationError)(Cause.squash(rollbackResult.cause)),
              true,
            );
          }
        }
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(`provider contract: ${providerKind} enforces user-input capability`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeIntegrationFixture(providerKind);

      yield* Effect.gen(function* () {
        const providerService = yield* ProviderService;
        const threadId = ThreadId.makeUnsafe(`thread-input-${providerKind}`);
        yield* providerService.startSession(threadId, {
          threadId,
          provider: providerKind,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        const capabilities = yield* providerService.getCapabilities(providerKind);
        const userInputResult = yield* Effect.exit(
          providerService.respondToUserInput({
            threadId,
            requestId: ApprovalRequestId.makeUnsafe("req-user-input"),
            answers: { answer: "yes" },
          }),
        );

        if (capabilities.supportsUserInput) {
          assert.equal(Exit.isSuccess(userInputResult), true);
        } else {
          assert.equal(Exit.isFailure(userInputResult), true);
          if (Exit.isFailure(userInputResult)) {
            assert.equal(
              Schema.is(ProviderAdapterValidationError)(Cause.squash(userInputResult.cause)),
              true,
            );
          }
        }
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const providerKind of PROVIDERS) {
  it.effect(`provider contract: ${providerKind} persists MCP refs according to capability`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeIntegrationFixture(providerKind);

      yield* Effect.gen(function* () {
        const providerService = yield* ProviderService;
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;
        const threadId = ThreadId.makeUnsafe(`thread-mcp-${providerKind}`);

        yield* providerService.startSession(threadId, {
          threadId,
          provider: providerKind,
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        const runtime = yield* runtimeRepository.getByThreadId({ threadId });
        assert.equal(runtime._tag, "Some");
        if (runtime._tag !== "Some") {
          return;
        }

        const payload = runtime.value.runtimePayload;
        assert.equal(
          payload !== null && typeof payload === "object" && !Array.isArray(payload),
          true,
        );
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return;
        }

        const capabilities = yield* providerService.getCapabilities(providerKind);
        const mcpConfigRef = "mcpConfigRef" in payload ? payload.mcpConfigRef : undefined;

        if (capabilities.mcpConfig === "none") {
          assert.equal(mcpConfigRef, undefined);
          assert.equal(
            fixture.analyticsEvents.some(
              (entry) =>
                entry.event === "mcp.config.deferred" &&
                entry.properties?.provider === providerKind &&
                entry.properties?.reason === "provider-capability-none",
            ),
            true,
          );
        } else {
          assert.equal(typeof mcpConfigRef === "object" && mcpConfigRef !== null, true);
          if (mcpConfigRef && typeof mcpConfigRef === "object") {
            const ref = mcpConfigRef as {
              version?: unknown;
              serverCount?: unknown;
              sourcePaths?: unknown;
            };
            assert.equal(ref.version, "mcp-v1");
            assert.equal(ref.serverCount, 1);
            assert.deepEqual(ref.sourcePaths, ["/workspace/.t3/mcp.json"]);
          }
          assert.equal(
            fixture.analyticsEvents.some(
              (entry) =>
                entry.event === "mcp.config.accepted" &&
                entry.properties?.provider === providerKind &&
                entry.properties?.serverCount === 1,
            ),
            true,
          );
        }
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
