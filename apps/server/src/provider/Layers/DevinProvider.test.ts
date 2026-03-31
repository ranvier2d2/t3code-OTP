import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { checkDevinProviderStatus, resolveDevinProviderSettings } from "./DevinProvider";
import { ProviderRegistryLive } from "./ProviderRegistry";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

describe("DevinProvider", () => {
  it.effect("resolves env-driven settings without contract support", () =>
    Effect.sync(() => {
      const settings = resolveDevinProviderSettings(
        { providers: {} },
        {
          T3CODE_DEVIN_ENABLED: "true",
          T3CODE_DEVIN_API_KEY: "cog_test",
          T3CODE_DEVIN_ORG_ID: "org-123",
        },
      );

      assert.deepStrictEqual(settings, {
        enabled: true,
        baseUrl: "https://api.devin.ai",
        apiKey: "cog_test",
        orgId: "org-123",
      });
    }),
  );

  it.effect("returns unauthenticated when the Devin token is missing", () =>
    Effect.gen(function* () {
      const status = yield* checkDevinProviderStatus({
        env: {
          T3CODE_DEVIN_ENABLED: "true",
          T3CODE_DEVIN_ORG_ID: "org-123",
        },
      });

      assert.strictEqual(status.provider, "devin");
      assert.strictEqual(status.status, "error");
      assert.strictEqual(status.authStatus, "unauthenticated");
      assert.strictEqual(status.installed, false);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("returns ready when /v3/self matches the configured org", () =>
    Effect.gen(function* () {
      const status = yield* checkDevinProviderStatus({
        env: {
          T3CODE_DEVIN_ENABLED: "true",
          T3CODE_DEVIN_API_KEY: "cog_test",
          T3CODE_DEVIN_ORG_ID: "org-123",
        },
        fetch: async () =>
          new Response(
            JSON.stringify({
              user_id: "user-1",
              org_id: "org-123",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      });

      assert.strictEqual(status.provider, "devin");
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.authStatus, "authenticated");
      assert.strictEqual(status.installed, true);
      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        ["devin-default"],
      );
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("returns an actionable error when the token org mismatches the configured org", () =>
    Effect.gen(function* () {
      const status = yield* checkDevinProviderStatus({
        env: {
          T3CODE_DEVIN_ENABLED: "true",
          T3CODE_DEVIN_API_KEY: "cog_test",
          T3CODE_DEVIN_ORG_ID: "org-expected",
        },
        fetch: async () =>
          new Response(
            JSON.stringify({
              user_id: "user-1",
              org_id: "org-actual",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      });

      assert.strictEqual(status.provider, "devin");
      assert.strictEqual(status.status, "error");
      assert.strictEqual(status.authStatus, "authenticated");
      assert.match(status.message ?? "", /Configured Devin org 'org-expected'/);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("registers Devin in the provider registry when env config is valid", () =>
    Effect.gen(function* () {
      const previousEnv = {
        T3CODE_DEVIN_ENABLED: process.env.T3CODE_DEVIN_ENABLED,
        T3CODE_DEVIN_API_KEY: process.env.T3CODE_DEVIN_API_KEY,
        T3CODE_DEVIN_ORG_ID: process.env.T3CODE_DEVIN_ORG_ID,
      };
      process.env.T3CODE_DEVIN_ENABLED = "true";
      process.env.T3CODE_DEVIN_API_KEY = "cog_test";
      process.env.T3CODE_DEVIN_ORG_ID = "org-123";
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            user_id: "user-1",
            org_id: "org-123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as unknown as typeof fetch;

      try {
        const registry = yield* ProviderRegistry;
        const providers = yield* registry.getProviders;
        assert.ok(providers.some((provider) => provider.provider === "devin"));
      } finally {
        if (previousEnv.T3CODE_DEVIN_ENABLED === undefined) {
          delete process.env.T3CODE_DEVIN_ENABLED;
        } else {
          process.env.T3CODE_DEVIN_ENABLED = previousEnv.T3CODE_DEVIN_ENABLED;
        }
        if (previousEnv.T3CODE_DEVIN_API_KEY === undefined) {
          delete process.env.T3CODE_DEVIN_API_KEY;
        } else {
          process.env.T3CODE_DEVIN_API_KEY = previousEnv.T3CODE_DEVIN_API_KEY;
        }
        if (previousEnv.T3CODE_DEVIN_ORG_ID === undefined) {
          delete process.env.T3CODE_DEVIN_ORG_ID;
        } else {
          process.env.T3CODE_DEVIN_ORG_ID = previousEnv.T3CODE_DEVIN_ORG_ID;
        }
        globalThis.fetch = previousFetch;
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest(),
          mockCommandSpawnerLayer((command, args) => {
            if (command === "codex" && args.join(" ") === "--version") {
              return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            }
            if (command === "codex" && args.join(" ") === "login status") {
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            }
            if (command === "claude" && args.join(" ") === "--version") {
              return { stdout: "claude 1.0.0\n", stderr: "", code: 0 };
            }
            if (command === "claude" && args.join(" ") === "auth status") {
              return { stdout: "Authenticated\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected provider probe: ${command} ${args.join(" ")}`);
          }),
        ).pipe((deps) => Layer.provideMerge(ProviderRegistryLive, deps)),
      ),
    ),
  );
});
