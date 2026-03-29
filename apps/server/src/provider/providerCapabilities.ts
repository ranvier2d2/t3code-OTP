import {
  DEFAULT_PROVIDER_CAPABILITIES,
  type ProviderCapabilities,
  type ProviderKind,
} from "@t3tools/contracts";

export const DIRECT_PROVIDER_CAPABILITIES = DEFAULT_PROVIDER_CAPABILITIES;

export const HARNESS_PROVIDER_CAPABILITIES: Record<
  Extract<ProviderKind, "codex" | "cursor" | "opencode">,
  ProviderCapabilities
> = {
  codex: {
    ...DEFAULT_PROVIDER_CAPABILITIES.codex,
    sessionModelSwitch: "restart-session",
  },
  cursor: {
    ...DEFAULT_PROVIDER_CAPABILITIES.cursor,
  },
  opencode: {
    ...DEFAULT_PROVIDER_CAPABILITIES.opencode,
    sessionModelSwitch: "restart-session",
  },
};
