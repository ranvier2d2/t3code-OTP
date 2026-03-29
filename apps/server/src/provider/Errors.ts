import { Schema } from "effect";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

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

export type ProviderErrorCategory =
  | "transient"
  | "permanent"
  | "configuration"
  | "provider-unavailable";

export type ProviderRecoveryStrategy =
  | "retry-backoff"
  | "fail-fast"
  | "re-resolve-config"
  | "fresh-session"
  | "degrade-gracefully"
  | "restart-session";

export interface ProviderErrorClassification {
  readonly category: ProviderErrorCategory;
  /**
   * Telemetry-only label for the recovery path we would ideally enact.
   *
   * ProviderService records this strategy today, but it does not yet drive
   * control flow directly.
   */
  readonly recoveryStrategy: ProviderRecoveryStrategy;
  readonly recoverable: boolean;
}

function requestErrorClassification(detail: string): ProviderErrorClassification {
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("rate limit") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("503")
  ) {
    return {
      category: "transient",
      recoveryStrategy: "retry-backoff",
      recoverable: true,
    };
  }

  if (
    normalized.includes("resume cursor") ||
    normalized.includes("invalid cursor") ||
    normalized.includes("session not found") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending user-input request")
  ) {
    return {
      category: "configuration",
      recoveryStrategy: "fresh-session",
      recoverable: true,
    };
  }

  if (
    normalized.includes("not installed") ||
    normalized.includes("enoent") ||
    normalized.includes("binary") ||
    (normalized.includes("harness") && normalized.includes("not running"))
  ) {
    return {
      category: "provider-unavailable",
      recoveryStrategy: "degrade-gracefully",
      recoverable: true,
    };
  }

  return {
    category: "permanent",
    recoveryStrategy: "fail-fast",
    recoverable: false,
  };
}

export function classifyProviderError(error: unknown): ProviderErrorClassification {
  if (
    Schema.is(ProviderAdapterValidationError)(error) ||
    Schema.is(ProviderValidationError)(error)
  ) {
    return {
      category: "permanent",
      recoveryStrategy: "fail-fast",
      recoverable: false,
    };
  }

  if (
    Schema.is(ProviderAdapterSessionNotFoundError)(error) ||
    Schema.is(ProviderSessionNotFoundError)(error)
  ) {
    return {
      category: "configuration",
      recoveryStrategy: "fresh-session",
      recoverable: true,
    };
  }

  if (Schema.is(ProviderAdapterSessionClosedError)(error)) {
    return {
      category: "transient",
      recoveryStrategy: "restart-session",
      recoverable: true,
    };
  }

  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return requestErrorClassification(error.detail);
  }

  if (Schema.is(ProviderAdapterProcessError)(error)) {
    const normalized = error.detail.toLowerCase();
    if (
      normalized.includes("not installed") ||
      normalized.includes("enoent") ||
      normalized.includes("no such file") ||
      normalized.includes("binary")
    ) {
      return {
        category: "provider-unavailable",
        recoveryStrategy: "degrade-gracefully",
        recoverable: true,
      };
    }

    return {
      category: "transient",
      recoveryStrategy: "restart-session",
      recoverable: true,
    };
  }

  if (Schema.is(ProviderUnsupportedError)(error)) {
    return {
      category: "provider-unavailable",
      recoveryStrategy: "degrade-gracefully",
      recoverable: true,
    };
  }

  if (Schema.is(ProviderSessionDirectoryPersistenceError)(error)) {
    return {
      category: "configuration",
      recoveryStrategy: "re-resolve-config",
      recoverable: true,
    };
  }

  return {
    category: "permanent",
    recoveryStrategy: "fail-fast",
    recoverable: false,
  };
}
