const MCP_SERVER_DISPLAY_NAMES = new Map<string, string>([
  ["context7", "Context7"],
  ["daytona", "Daytona"],
  ["linear", "Linear"],
  ["notion", "Notion"],
  ["openaiDeveloperDocs", "OpenAI Developer Docs"],
  ["playwright", "Playwright"],
  ["RepoPrompt", "RepoPrompt"],
  ["ref", "Ref"],
  ["vercel", "Vercel"],
]);

const MCP_SERVER_NAME_ALIASES = new Map<string, string>([
  ["context7", "context7"],
  ["daytona", "daytona"],
  ["linear", "linear"],
  ["notion", "notion"],
  ["openai docs", "openaiDeveloperDocs"],
  ["openai documentation", "openaiDeveloperDocs"],
  ["openai developer docs", "openaiDeveloperDocs"],
  ["openai developer documentation", "openaiDeveloperDocs"],
  ["playwright", "playwright"],
  ["ref", "ref"],
  ["ref.tools", "ref"],
  ["repo prompt", "RepoPrompt"],
  ["repoprompt", "RepoPrompt"],
  ["vercel", "vercel"],
]);

function normalizeAliasKey(server: string): string {
  return server.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeMcpServerName(server: string): string {
  const trimmed = server.trim();
  if (trimmed.length === 0) {
    return server;
  }

  const prefixed = normalizeAliasKey(trimmed);
  const withoutClaudePrefix = prefixed.startsWith("claude.ai ")
    ? prefixed.slice("claude.ai ".length)
    : prefixed;

  return (
    MCP_SERVER_NAME_ALIASES.get(prefixed) ??
    MCP_SERVER_NAME_ALIASES.get(withoutClaudePrefix) ??
    trimmed.replace(/^claude\.ai\s+/i, "")
  );
}

export function humanizeMcpServerName(server: string): string {
  const normalized = normalizeMcpServerName(server);
  const known = MCP_SERVER_DISPLAY_NAMES.get(normalized);
  if (known) {
    return known;
  }
  const spaced = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.length > 0 ? spaced[0]!.toUpperCase() + spaced.slice(1) : normalized;
}
