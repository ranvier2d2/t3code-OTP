/**
 * Provider Contract Integration Tests
 *
 * Capability-driven contract test suite that validates the ProviderAdapterShape
 * contract against a test adapter harness. Tests auto-skip for capabilities
 * declared as unsupported by the adapter.
 *
 * Covers: session lifecycle, rollback, resume, user-input, and approval flows.
 *
 * @module contract.integration.test
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, describe } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Queue, Stream } from "effect";

import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { McpConfigServiceLive } from "../src/provider/Layers/McpConfig.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

// ---------------------------------------------------------------------------
// Test harness capabilities (from the test adapter)
// ---------------------------------------------------------------------------

const capabilities = {
  supportsRollback: true,
  supportsUserInput: true,
  supportsFileChangeApproval: true,
  supportsResume: true,
  sessionModelSwitch: "in-session" as const,
};

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface ContractFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService, unknown, never>;
}

const makeContractFixture = Effect.gen(function* () {
  const cwd = yield* makeWorkspaceDirectory;
  const harness = yield* makeTestProviderAdapterHarness();

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(harness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );

  const shared = Layer.mergeAll(
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, registry),
    ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
    AnalyticsService.layerTest,
  ).pipe(Layer.provide(SqlitePersistenceMemory));

  const layer = makeProviderServiceLive().pipe(
    Layer.provide(shared),
    Layer.provide(McpConfigServiceLive),
  );

  return {
    cwd,
    harness,
    layer,
  } satisfies ContractFixture;
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

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);
    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

// ---------------------------------------------------------------------------
// Contract: Session Lifecycle
// ---------------------------------------------------------------------------

describe("Provider Contract: session lifecycle", () => {
  it.effect("starts a session, sends a turn, and stops cleanly", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;

        // Start session
        const session = yield* provider.startSession(ThreadId.makeUnsafe("contract-lifecycle-1"), {
          threadId: ThreadId.makeUnsafe("contract-lifecycle-1"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });
        assert.equal(session.status, "ready");
        assert.equal(session.provider, "codex");

        // Send turn
        const events = yield* runTurn({
          provider,
          harness: fixture.harness,
          threadId: session.threadId,
          userText: "hello contract",
          response: { events: codexTurnTextFixture },
        });
        assert.isAbove(events.length, 0);

        // List sessions includes our session
        const sessions = yield* provider.listSessions();
        assert.isAbove(sessions.length, 0);

        // Stop session
        yield* provider.stopSession({ threadId: session.threadId });
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns capabilities for registered providers", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const caps = yield* provider.getCapabilities("codex");

        assert.isString(caps.sessionModelSwitch);
        assert.isBoolean(caps.supportsUserInput);
        assert.isBoolean(caps.supportsRollback);
        assert.isBoolean(caps.supportsFileChangeApproval);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// Contract: Rollback
// ---------------------------------------------------------------------------

describe.skipIf(!capabilities.supportsRollback)("Provider Contract: rollback", () => {
  it.effect("rolls back N turns", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(ThreadId.makeUnsafe("contract-rollback-1"), {
          threadId: ThreadId.makeUnsafe("contract-rollback-1"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        // Send two turns
        yield* runTurn({
          provider,
          harness: fixture.harness,
          threadId: session.threadId,
          userText: "turn 1",
          response: { events: codexTurnTextFixture },
        });
        yield* runTurn({
          provider,
          harness: fixture.harness,
          threadId: session.threadId,
          userText: "turn 2",
          response: { events: codexTurnTextFixture },
        });

        // Rollback 1 turn
        yield* provider.rollbackConversation({
          threadId: session.threadId,
          numTurns: 1,
        });

        const rollbackCalls = fixture.harness.getRollbackCalls(session.threadId);
        assert.deepEqual(rollbackCalls, [1]);

        yield* provider.stopSession({ threadId: session.threadId });
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// Contract: Resume (session recovery)
// ---------------------------------------------------------------------------

describe.skipIf(!capabilities.supportsResume)("Provider Contract: resume", () => {
  it.effect("starts a session with a resume cursor", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(ThreadId.makeUnsafe("contract-resume-1"), {
          threadId: ThreadId.makeUnsafe("contract-resume-1"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
          resumeCursor: { threadId: "existing-thread" },
        });

        assert.equal(session.status, "ready");
        assert.isDefined(session.resumeCursor);

        yield* provider.stopSession({ threadId: session.threadId });
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// Contract: Approval flow
// ---------------------------------------------------------------------------

describe.skipIf(!capabilities.supportsFileChangeApproval)("Provider Contract: approval", () => {
  it.effect("handles approval request and response flow", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(ThreadId.makeUnsafe("contract-approval-1"), {
          threadId: ThreadId.makeUnsafe("contract-approval-1"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        // Run a turn with an approval request in the fixture events
        const events = yield* runTurn({
          provider,
          harness: fixture.harness,
          threadId: session.threadId,
          userText: "make a change requiring approval",
          response: { events: codexTurnApprovalFixture },
        });

        // The fixture contains an approval request event
        const requestEvent = events.find((e) => e.type === "request.opened");
        assert.isDefined(requestEvent);

        yield* provider.stopSession({ threadId: session.threadId });
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// Contract: User Input
// ---------------------------------------------------------------------------

describe.skipIf(!capabilities.supportsUserInput)("Provider Contract: user-input", () => {
  it.effect("adapter declares user-input support in capabilities", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const caps = yield* provider.getCapabilities("codex");
        assert.isTrue(caps.supportsUserInput);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---------------------------------------------------------------------------
// Contract: Tool/file-change flow
// ---------------------------------------------------------------------------

describe("Provider Contract: tool execution", () => {
  it.effect("runs a turn with tool/file-change events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeContractFixture;
      const { join } = yield* Path.Path;
      const { writeFileString } = yield* FileSystem.FileSystem;

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const session = yield* provider.startSession(ThreadId.makeUnsafe("contract-tools-1"), {
          threadId: ThreadId.makeUnsafe("contract-tools-1"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });

        const events = yield* runTurn({
          provider,
          harness: fixture.harness,
          threadId: session.threadId,
          userText: "make a file change",
          response: {
            events: codexTurnToolFixture,
            mutateWorkspace: ({ cwd }) =>
              writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
          },
        });

        assert.isAbove(events.length, 0);
        yield* provider.stopSession({ threadId: session.threadId });
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
