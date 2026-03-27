/**
 * HarnessClientAdapter — Service tag for the Elixir harness bridge adapter.
 *
 * Mirrors `CodexAdapter` in structure: a `ServiceMap.Service` keyed by a
 * canonical string identifier, holding a `ProviderAdapterShape` specialised
 * for `ProviderAdapterError` and `provider: "codex"` (the harness bridges
 * internally to any provider; we advertise "codex" for the time being).
 *
 * @module HarnessClientAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * HarnessClientAdapterShape — Service API for the Elixir harness bridge adapter.
 */
export interface HarnessClientAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";
  /** Query the Elixir harness for available models for a harness-routed provider. */
  readonly listProviderModels: (
    provider: string,
  ) => Promise<ReadonlyArray<{ slug: string; name: string }>>;
}

/**
 * HarnessClientAdapter — Service tag for the harness bridge provider adapter.
 */
export class HarnessClientAdapter extends ServiceMap.Service<
  HarnessClientAdapter,
  HarnessClientAdapterShape
>()("t3/provider/Services/HarnessClientAdapter") {}
