#!/usr/bin/env bun
/**
 * council-dispatch.ts -- Phase A of fire-and-forget council.
 *
 * Creates threads and dispatches the same prompt to N providers simultaneously.
 * Writes a session manifest to disk and exits in <15s. Does NOT wait for responses.
 *
 * The manifest file can be read by council-collect.ts (Phase B) to poll for
 * completion and run synthesis.
 *
 * Usage:
 *   bun run scripts/council-dispatch.ts "Your prompt here"
 *   bun run scripts/council-dispatch.ts --providers codex,claudeAgent "Quick council"
 *   bun run scripts/council-dispatch.ts --file context.md "Review this"
 *   bun run scripts/council-dispatch.ts --manifest /tmp/council.json "Prompt"
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { T3Client } from "./lib/t3-client.ts";

// ---------------------------------------------------------------------------
// Council model configuration (shared with council.ts)
// ---------------------------------------------------------------------------

const COUNCIL_MODELS: Record<string, { provider: string; model: string; label: string }> = {
  codex: { provider: "codex", model: "gpt-5.4", label: "GPT-5.4 (Codex)" },
  claudeAgent: {
    provider: "claudeAgent",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6 (Claude Code)",
  },
  cursor: { provider: "cursor", model: "composer-2", label: "Composer 2 (Cursor)" },
  opencode: {
    provider: "opencode",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (OpenCode)",
  },
};

const SYNTHESIS_MODEL = { provider: "codex", model: "gpt-5.4", label: "GPT-5.4 (Synthesizer)" };

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

/**
 * Retrieve the value that immediately follows a given CLI flag in the parsed args.
 *
 * @param flag - The CLI flag to search for (include leading dashes, e.g. `--file`)
 * @returns The token following `flag` if present and not another `--` flag, `undefined` otherwise
 */
function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  const next = idx >= 0 ? args[idx + 1] : undefined;
  if (next && !next.startsWith("--")) return next;
  return undefined;
}

const fileArg = getFlag("--file");
const providersArg = getFlag("--providers");
const manifestPath =
  getFlag("--manifest") ?? `/tmp/council-${crypto.randomUUID().slice(0, 8)}.json`;

const promptArgs = args.filter((a, i) => {
  if (a.startsWith("--")) return false;
  if (i > 0 && args[i - 1]?.startsWith("--")) return false;
  return true;
});
const userPromptRaw = promptArgs.join(" ").trim();

if (!userPromptRaw) {
  console.error(
    `Usage: bun run scripts/council-dispatch.ts [--file context.md] [--providers codex,claudeAgent] "Your prompt"`,
  );
  process.exit(1);
}

let userPrompt = userPromptRaw;
if (fileArg) {
  try {
    const fileContent = readFileSync(fileArg, "utf-8");
    userPrompt = `## Context from ${fileArg}\n\n${fileContent}\n\n## Question\n\n${userPromptRaw}`;
  } catch (e) {
    console.error(`Failed to read file: ${fileArg}`, e);
    process.exit(1);
  }
}

const activeProviders = providersArg
  ? providersArg.split(",").filter((p) => p in COUNCIL_MODELS)
  : Object.keys(COUNCIL_MODELS);

if (activeProviders.length === 0) {
  console.error(`No valid providers. Available: ${Object.keys(COUNCIL_MODELS).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
/**
 * Generates a short, random identifier.
 *
 * @returns An 8-character string derived from a UUID suitable for use in filenames or IDs.
 */

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Manifest type (written to disk for Phase B)
// ---------------------------------------------------------------------------

interface CouncilManifest {
  councilId: string;
  prompt: string;
  promptRaw: string;
  dispatchedAt: string;
  projectId: string;
  members: Array<{
    providerKey: string;
    provider: string;
    model: string;
    label: string;
    threadId: string;
  }>;
  synthesisModel: typeof SYNTHESIS_MODEL;
  manifestPath: string;
}

// ---------------------------------------------------------------------------
// Main
/**
 * Dispatches the provided prompt to a separate thread for each active provider in T3, records the dispatched threads and metadata to a manifest file, and exits the process.
 *
 * Connects to a T3 project (using a bootstrap ID or snapshot lookup), creates a thread and starts a user turn with the final prompt for each configured provider, collects per-provider thread metadata into a manifest, writes the manifest to disk (ensuring the target directory exists), and disconnects before exiting.
 *
 * @throws Error if no project can be found in the connected T3 instance
 */

async function main() {
  const councilId = shortId();
  console.log(`Council ${councilId}: dispatching to ${activeProviders.length} providers...`);

  // Connect
  const client = new T3Client({ requestTimeout: 30_000 });
  const welcome = await client.connect();
  let projectId = (welcome.bootstrapProjectId as string) ?? "";

  // Desktop mode may not include bootstrapProjectId in welcome — look it up
  if (!projectId) {
    const snapshot = (await client.send("orchestration.getSnapshot", {})) as {
      projects?: Array<{ id: string }>;
    };
    projectId = snapshot?.projects?.[0]?.id ?? "";
  }
  if (!projectId) {
    throw new Error("No project found — open a project in T3 Code first");
  }

  // Create threads and dispatch turns
  const members: CouncilManifest["members"] = [];

  for (const providerKey of activeProviders) {
    const cfg = COUNCIL_MODELS[providerKey]!;
    const threadId = `council-${providerKey}-${councilId}`;

    try {
      await client.dispatch({
        type: "thread.create",
        commandId: `cmd-create-${threadId}`,
        threadId,
        projectId,
        title: `Council: ${providerKey} ${councilId}`,
        modelSelection: { provider: cfg.provider, model: cfg.model },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now(),
      });

      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-turn-${threadId}-${shortId()}`,
        threadId,
        message: {
          messageId: `msg-${crypto.randomUUID()}`,
          role: "user",
          text: userPrompt,
          attachments: [],
        },
        modelSelection: { provider: cfg.provider, model: cfg.model },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now(),
      });

      members.push({
        providerKey,
        provider: cfg.provider,
        model: cfg.model,
        label: cfg.label,
        threadId,
      });
      console.log(`  Dispatched: ${cfg.label} -> thread ${threadId}`);
    } catch (e) {
      console.error(`  Failed to dispatch ${providerKey}: ${e}`);
    }
  }

  client.disconnect();

  if (members.length === 0) {
    console.error("No providers dispatched successfully.");
    process.exit(1);
  }

  // Write manifest
  const manifest: CouncilManifest = {
    councilId,
    prompt: userPrompt,
    promptRaw: userPromptRaw,
    dispatchedAt: now(),
    projectId,
    members,
    synthesisModel: SYNTHESIS_MODEL,
    manifestPath,
  };

  mkdirSync("/tmp", { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to: ${manifestPath}`);
  console.log(`${members.length} providers dispatched. Run council-collect.ts to collect results.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Dispatch failed:", e);
  process.exit(2);
});
