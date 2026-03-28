import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  classifyProviderError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderSessionDirectoryPersistenceError,
} from "./Errors.ts";

it.effect("classifies timeout request errors as transient retryable failures", () =>
  Effect.sync(() => {
    const classification = classifyProviderError(
      new ProviderAdapterRequestError({
        provider: "codex",
        method: "sendTurn",
        detail: "Harness request timed out after 20000ms",
      }),
    );

    assert.deepEqual(classification, {
      category: "transient",
      recoveryStrategy: "retry-backoff",
      recoverable: true,
    });
  }),
);

it.effect("classifies process ENOENT errors as provider unavailable", () =>
  Effect.sync(() => {
    const classification = classifyProviderError(
      new ProviderAdapterProcessError({
        provider: "codex",
        threadId: "thread-1",
        detail: "spawn codex ENOENT",
      }),
    );

    assert.deepEqual(classification, {
      category: "provider-unavailable",
      recoveryStrategy: "degrade-gracefully",
      recoverable: true,
    });
  }),
);

it.effect("classifies persistence failures as configuration issues", () =>
  Effect.sync(() => {
    const classification = classifyProviderError(
      new ProviderSessionDirectoryPersistenceError({
        operation: "upsert",
        detail: "sqlite busy",
      }),
    );

    assert.deepEqual(classification, {
      category: "configuration",
      recoveryStrategy: "re-resolve-config",
      recoverable: true,
    });
  }),
);
