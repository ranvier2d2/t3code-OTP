import { Schema } from "effect";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Error category for provider errors.
 *
 * - `"transient"` — temporary failure that may succeed on retry (network timeout, rate-limit).
 * - `"permanent"` — unrecoverable error (bad request, auth failure, missing resource).
 * - `"configuration"` — misconfigured provider or environment (wrong API key, missing binary).
 * - `"unavailable"` — provider is down or unreachable (graceful degradation path).
 */
export type ProviderErrorCategory = "transient" | "permanent" | "configuration" | "unavailable";

/**
 * Classify a provider error into a recovery-actionable category.
 *
 * Recovery strategies per category:
 * - transient      -> retry with exponential backoff
 * - permanent      -> fail immediately and report to the user
 * - configuration  -> re-resolve configuration / prompt user to fix settings
 * - unavailable    -> degrade gracefully (e.g. mark provider as offline)
 */
export function classifyProviderError(
  error:
    | ProviderAdapterError
    | ProviderValidationError
    | ProviderUnsupportedError
    | ProviderSessionNotFoundError
    | ProviderSessionDirectoryPersistenceError,
): ProviderErrorCategory {
  const tag = (error as { readonly _tag: string })._tag;

  switch (tag) {
    case "ProviderAdapterRequestError": {
      // Request errors are generally transient (timeout, network) unless the
      // detail indicates a permanent issue.
      const detail = ((error as ProviderAdapterRequestError).detail ?? "").toLowerCase();
      if (
        detail.includes("timeout") ||
        detail.includes("rate limit") ||
        detail.includes("econnreset") ||
        detail.includes("econnrefused") ||
        detail.includes("socket hang up")
      ) {
        return "transient";
      }
      if (
        detail.includes("not found") ||
        detail.includes("unauthorized") ||
        detail.includes("forbidden")
      ) {
        return "permanent";
      }
      // Default request errors to transient — safer to retry.
      return "transient";
    }

    case "ProviderAdapterProcessError": {
      const detail = ((error as ProviderAdapterProcessError).detail ?? "").toLowerCase();
      if (
        detail.includes("not found") ||
        detail.includes("enoent") ||
        detail.includes("permission denied")
      ) {
        return "configuration";
      }
      if (detail.includes("crashed") || detail.includes("signal")) {
        return "unavailable";
      }
      return "transient";
    }

    case "ProviderAdapterValidationError":
    case "ProviderAdapterSessionNotFoundError":
    case "ProviderAdapterSessionClosedError":
    case "ProviderValidationError":
    case "ProviderSessionNotFoundError":
      return "permanent";

    case "ProviderUnsupportedError":
      return "configuration";

    case "ProviderSessionDirectoryPersistenceError":
      return "transient";

    default:
      // Fallback — treat unknown errors as transient to allow retry.
      return "transient";
  }
}

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;
