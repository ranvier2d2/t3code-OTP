import { ProviderKind, type ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

// ---------------------------------------------------------------------------
// adapter_key migration (Task 007 — codex-harness-only cutover)
// ---------------------------------------------------------------------------

/**
 * Maps legacy adapter_key values to their harness equivalents.
 * When the harness became the default for Codex, persisted sessions using the
 * old direct-adapter key need to be transparently migrated on next load.
 */
const LEGACY_ADAPTER_KEY_MAP: Record<string, string> = {
  codex: "harness:codex",
};

/** Track which threads have already logged their migration to avoid log spam. */
const _migratedThreadIds = new Set<string>();

/**
 * If the persisted `adapterKey` is a legacy value, return the migrated key and
 * log the migration for observability (once per thread per process lifetime).
 * Otherwise return the key unchanged.
 */
function migrateAdapterKey(
  adapterKey: string,
  threadId: string,
): { readonly key: string; readonly migrated: boolean } {
  const mapped = LEGACY_ADAPTER_KEY_MAP[adapterKey];
  if (mapped !== undefined) {
    if (!_migratedThreadIds.has(threadId)) {
      _migratedThreadIds.add(threadId);
      console.log(
        `[adapter_key_migration] thread=${threadId} old_key=${adapterKey} new_key=${mapped}`,
      );
    }
    return { key: mapped, migrated: true };
  }
  return { key: adapterKey, migrated: false };
}

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  if (Schema.is(ProviderKind)(providerName)) {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Unknown persisted provider '${providerName}'.`,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            decodeProviderKind(value.providerName, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((provider) => {
                // Migrate legacy adapter_key values (Task 007)
                const { key: adapterKey } = migrateAdapterKey(value.adapterKey, value.threadId);
                return Option.some({
                  threadId: value.threadId,
                  provider,
                  adapterKey,
                  runtimeMode: value.runtimeMode,
                  status: value.status,
                  resumeCursor: value.resumeCursor,
                  runtimePayload: value.runtimePayload,
                });
              }),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          binding.runtimePayload,
        ),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (threadId) =>
    repository
      .deleteByThreadId({ threadId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteByThreadId")),
      );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  return {
    upsert,
    getProvider,
    getBinding,
    remove,
    listThreadIds,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
