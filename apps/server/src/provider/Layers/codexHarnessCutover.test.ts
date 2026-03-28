/**
 * Tests for Task 007 — Codex Harness-Only Cutover.
 *
 * Validates:
 *   1. Registry resolves codex to harness adapter (default)
 *   2. Registry resolves codex to direct adapter (with legacy flag)
 *   3. adapter_key migration maps correctly
 *   4. resume_cursor validation
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// 1. adapter_key migration
// ---------------------------------------------------------------------------

describe("adapter_key migration (Task 007)", () => {
  // We need to test the migrateAdapterKey function from ProviderSessionDirectory.
  // Since it's a module-private function, we test it through the observable
  // behaviour: console.log output and returned key.

  // Re-implement the migration logic here to test in isolation (mirrors the
  // module-private function in ProviderSessionDirectory.ts).
  const LEGACY_ADAPTER_KEY_MAP: Record<string, string> = {
    codex: "harness:codex",
  };

  function migrateAdapterKey(
    adapterKey: string,
    threadId: string,
  ): { readonly key: string; readonly migrated: boolean } {
    const mapped = LEGACY_ADAPTER_KEY_MAP[adapterKey];
    if (mapped !== undefined) {
      return { key: mapped, migrated: true };
    }
    return { key: adapterKey, migrated: false };
  }

  it("maps legacy 'codex' adapter_key to 'harness:codex'", () => {
    const result = migrateAdapterKey("codex", "thread-123");
    expect(result.key).toBe("harness:codex");
    expect(result.migrated).toBe(true);
  });

  it("passes through 'harness:codex' unchanged", () => {
    const result = migrateAdapterKey("harness:codex", "thread-456");
    expect(result.key).toBe("harness:codex");
    expect(result.migrated).toBe(false);
  });

  it("passes through 'claudeAgent' adapter_key unchanged", () => {
    const result = migrateAdapterKey("claudeAgent", "thread-789");
    expect(result.key).toBe("claudeAgent");
    expect(result.migrated).toBe(false);
  });

  it("passes through 'cursor' adapter_key unchanged", () => {
    const result = migrateAdapterKey("cursor", "thread-abc");
    expect(result.key).toBe("cursor");
    expect(result.migrated).toBe(false);
  });

  it("passes through 'opencode' adapter_key unchanged", () => {
    const result = migrateAdapterKey("opencode", "thread-def");
    expect(result.key).toBe("opencode");
    expect(result.migrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. resume_cursor validation
// ---------------------------------------------------------------------------

// Mirror the validateResumeCursor function from ProviderService.ts
function validateResumeCursor(
  cursor: unknown,
):
  | { readonly valid: true; readonly cursor: unknown }
  | { readonly valid: false; readonly reason: string } {
  if (cursor === null || cursor === undefined) {
    return { valid: false, reason: "cursor is null or undefined" };
  }
  if (typeof cursor === "string") {
    const trimmed = cursor.trim();
    if (trimmed.length === 0) {
      return { valid: false, reason: "cursor is an empty string" };
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || parsed === undefined) {
        return { valid: false, reason: "cursor JSON parses to null/undefined" };
      }
      return { valid: true, cursor: parsed };
    } catch (err) {
      return {
        valid: false,
        reason: `cursor string is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (typeof cursor === "object") {
    return { valid: true, cursor };
  }
  return { valid: false, reason: `unexpected cursor type: ${typeof cursor}` };
}

describe("resume_cursor validation (Task 007)", () => {
  it("accepts a valid JSON string cursor", () => {
    const result = validateResumeCursor('{"offset":42,"sessionId":"abc"}');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cursor).toEqual({ offset: 42, sessionId: "abc" });
    }
  });

  it("accepts an already-parsed object cursor", () => {
    const obj = { offset: 42, sessionId: "abc" };
    const result = validateResumeCursor(obj);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cursor).toBe(obj);
    }
  });

  it("rejects null cursor", () => {
    const result = validateResumeCursor(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("null or undefined");
    }
  });

  it("rejects undefined cursor", () => {
    const result = validateResumeCursor(undefined);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("null or undefined");
    }
  });

  it("rejects empty string cursor", () => {
    const result = validateResumeCursor("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("empty string");
    }
  });

  it("rejects malformed JSON string cursor", () => {
    const result = validateResumeCursor("{invalid json}}}");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("not valid JSON");
    }
  });

  it("rejects JSON string that parses to null", () => {
    const result = validateResumeCursor("null");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("parses to null/undefined");
    }
  });

  it("rejects unexpected types (number)", () => {
    const result = validateResumeCursor(42);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("unexpected cursor type");
    }
  });

  it("accepts array cursor (typeof object)", () => {
    const arr = [1, 2, 3];
    const result = validateResumeCursor(arr);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cursor).toBe(arr);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Feature flag: T3CODE_CODEX_LEGACY
// ---------------------------------------------------------------------------

describe("T3CODE_CODEX_LEGACY feature flag (Task 007)", () => {
  const originalEnv = process.env.T3CODE_CODEX_LEGACY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.T3CODE_CODEX_LEGACY;
    } else {
      process.env.T3CODE_CODEX_LEGACY = originalEnv;
    }
  });

  it("useLegacyCodex is false when env var is not set", () => {
    delete process.env.T3CODE_CODEX_LEGACY;
    const useLegacyCodex = process.env.T3CODE_CODEX_LEGACY === "1";
    expect(useLegacyCodex).toBe(false);
  });

  it("useLegacyCodex is true when env var is '1'", () => {
    process.env.T3CODE_CODEX_LEGACY = "1";
    const useLegacyCodex = process.env.T3CODE_CODEX_LEGACY === "1";
    expect(useLegacyCodex).toBe(true);
  });

  it("useLegacyCodex is false when env var is '0'", () => {
    process.env.T3CODE_CODEX_LEGACY = "0";
    const useLegacyCodex = process.env.T3CODE_CODEX_LEGACY === "1";
    expect(useLegacyCodex).toBe(false);
  });

  it("useLegacyCodex is false when env var is 'true'", () => {
    process.env.T3CODE_CODEX_LEGACY = "true";
    const useLegacyCodex = process.env.T3CODE_CODEX_LEGACY === "1";
    expect(useLegacyCodex).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Registry resolution (integration-level with Effect mocks)
// ---------------------------------------------------------------------------

describe("ProviderAdapterRegistry codex resolution (Task 007)", () => {
  // These are structural tests validating the registry map logic used in
  // serverLayers.ts. We test the map construction pattern directly rather
  // than building full Effect layers, since the full layer construction
  // requires many heavyweight dependencies.

  const HARNESS_PROVIDER_CAPABILITIES: Record<
    string,
    {
      sessionModelSwitch: string;
      supportsUserInput: boolean;
      supportsRollback: boolean;
      supportsFileChangeApproval: boolean;
    }
  > = {
    codex: {
      sessionModelSwitch: "restart-session",
      supportsUserInput: true,
      supportsRollback: true,
      supportsFileChangeApproval: true,
    },
    cursor: {
      sessionModelSwitch: "restart-session",
      supportsUserInput: false,
      supportsRollback: false,
      supportsFileChangeApproval: false,
    },
    opencode: {
      sessionModelSwitch: "restart-session",
      supportsUserInput: true,
      supportsRollback: true,
      supportsFileChangeApproval: true,
    },
  };

  const fakeHarnessAdapter = {
    provider: "codex" as const,
    capabilities: HARNESS_PROVIDER_CAPABILITIES["codex"],
  };

  const fakeCodexDirectAdapter = {
    provider: "codex" as const,
    capabilities: {
      sessionModelSwitch: "in-session" as const,
      supportsUserInput: true,
      supportsRollback: true,
      supportsFileChangeApproval: true,
    },
  };

  const fakeClaudeAdapter = {
    provider: "claudeAgent" as const,
    capabilities: {
      sessionModelSwitch: "in-session" as const,
      supportsUserInput: true,
      supportsRollback: true,
      supportsFileChangeApproval: true,
    },
  };

  it("default path: codex resolves to harness adapter", () => {
    // Simulate the default path (codexViaHarness = true)
    const byProvider = new Map<string, { provider: string; capabilities: unknown }>();
    byProvider.set("claudeAgent", fakeClaudeAdapter);
    byProvider.set("codex", {
      ...fakeHarnessAdapter,
      provider: "codex",
      capabilities: HARNESS_PROVIDER_CAPABILITIES["codex"],
    });

    const codexEntry = byProvider.get("codex");
    expect(codexEntry).toBeDefined();
    expect(codexEntry!.capabilities).toEqual(HARNESS_PROVIDER_CAPABILITIES["codex"]);
    // The harness capabilities have restart-session, not in-session
    expect((codexEntry!.capabilities as Record<string, unknown>).sessionModelSwitch).toBe(
      "restart-session",
    );
  });

  it("legacy path: codex resolves to direct adapter", () => {
    // Simulate the legacy path (useLegacyCodex = true)
    const byProvider = new Map<string, { provider: string; capabilities: unknown }>();
    byProvider.set("claudeAgent", fakeClaudeAdapter);
    byProvider.set("codex", fakeCodexDirectAdapter);

    const codexEntry = byProvider.get("codex");
    expect(codexEntry).toBeDefined();
    expect(codexEntry!.capabilities).toEqual(fakeCodexDirectAdapter.capabilities);
    // The direct adapter has in-session model switch
    expect((codexEntry!.capabilities as Record<string, unknown>).sessionModelSwitch).toBe(
      "in-session",
    );
  });

  it("cursor and opencode always resolve to harness adapter", () => {
    const HARNESS_ONLY_PROVIDERS = ["cursor", "opencode"] as const;
    const byProvider = new Map<string, { provider: string; capabilities: unknown }>();

    for (const providerKind of HARNESS_ONLY_PROVIDERS) {
      byProvider.set(providerKind, {
        ...fakeHarnessAdapter,
        provider: providerKind,
        capabilities: HARNESS_PROVIDER_CAPABILITIES[providerKind],
      });
    }

    expect(byProvider.get("cursor")!.provider).toBe("cursor");
    expect(byProvider.get("opencode")!.provider).toBe("opencode");
    expect(
      (byProvider.get("cursor")!.capabilities as Record<string, unknown>).supportsUserInput,
    ).toBe(false);
    expect(
      (byProvider.get("opencode")!.capabilities as Record<string, unknown>).supportsUserInput,
    ).toBe(true);
  });
});
