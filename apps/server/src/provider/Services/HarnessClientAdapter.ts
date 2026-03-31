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
  readonly provider: "codex" | "cursor" | "opencode";
  /** Query the harness for available models for a given provider. */
  readonly listModels: (
    provider: string,
  ) => import("effect").Effect.Effect<ReadonlyArray<{ slug: string; name: string }>>;
  /** Get MCP server status from an active OpenCode session. */
  readonly mcpStatus: (
    threadId: string,
  ) => import("effect").Effect.Effect<Record<string, unknown>, ProviderAdapterError>;
  /** Add an MCP server configuration to an active OpenCode session. */
  readonly mcpAdd: (
    threadId: string,
    name: string,
    config: Record<string, unknown>,
  ) => import("effect").Effect.Effect<Record<string, unknown>, ProviderAdapterError>;
  /** Connect an MCP server in an active OpenCode session. */
  readonly mcpConnect: (
    threadId: string,
    name: string,
  ) => import("effect").Effect.Effect<void, ProviderAdapterError>;
  /** Disconnect an MCP server in an active OpenCode session. */
  readonly mcpDisconnect: (
    threadId: string,
    name: string,
  ) => import("effect").Effect.Effect<void, ProviderAdapterError>;
  /** Set a session configuration option (model, mode, etc.) via ACP set_config_option. */
  readonly setConfig: (
    threadId: string & import("effect").Brand.Brand<"ThreadId">,
    configId: string,
    value: string,
  ) => import("effect").Effect.Effect<void, ProviderAdapterError>;
}

/**
 * HarnessClientAdapter — Service tag for the harness bridge provider adapter.
 */
export class HarnessClientAdapter extends ServiceMap.Service<
  HarnessClientAdapter,
  HarnessClientAdapterShape
>()("t3/provider/Services/HarnessClientAdapter") {}
