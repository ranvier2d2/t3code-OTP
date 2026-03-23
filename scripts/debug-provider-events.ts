#!/usr/bin/env bun
/**
 * debug-provider-events.ts — CLI script to test a provider via the harness
 * and log every raw event for debugging.
 *
 * Usage:
 *   bun run scripts/debug-provider-events.ts [provider] [prompt]
 *
 * Examples:
 *   bun run scripts/debug-provider-events.ts codex "say hello in one word"
 *   bun run scripts/debug-provider-events.ts cursor "say hello in one word"
 *   bun run scripts/debug-provider-events.ts opencode "say hello in one word"
 *   bun run scripts/debug-provider-events.ts claudeAgent "say hello in one word"
 *
 * Env:
 *   T3CODE_HARNESS_PORT   (default: 4321)
 *   T3CODE_HARNESS_SECRET (default: dev-harness-secret)
 */

import { HarnessClientManager, type HarnessRawEvent } from "../apps/server/src/provider/Layers/HarnessClientManager.ts";
import { mapToRuntimeEvents } from "../apps/server/src/provider/Layers/codexEventMapping.ts";

const provider = process.argv[2] || "codex";
const prompt = process.argv[3] || "say hello in one word";
const port = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const secret = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const threadId = `debug-${Date.now()}`;
const cwd = process.cwd();

// Timestamp helper
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Event collector
const events: Array<{ ts: string; kind: string; method: string; turnId?: string; payload: unknown }> = [];

console.log(`\n=== Provider Debug: ${provider} ===`);
console.log(`Thread: ${threadId}`);
console.log(`Prompt: "${prompt}"`);
console.log(`Harness: ws://localhost:${port}\n`);

const mgr = new HarnessClientManager({
  harnessPort: port,
  harnessSecret: secret,
  onEvent: (raw: HarnessRawEvent) => {
    if (raw.threadId !== threadId) return; // ignore other threads

    const payload = raw.payload as Record<string, unknown> | undefined;
    const turnId =
      (payload?.turnId as string) ??
      (payload?.turn_id as string) ??
      ((payload?.turn as Record<string, unknown>)?.id as string) ??
      ((payload?.msg as Record<string, unknown>)?.turn_id as string) ??
      undefined;

    const entry = { ts: ts(), kind: raw.kind, method: raw.method, turnId, payload: raw.payload };
    events.push(entry);

    // Compact log line
    const turnTag = turnId ? ` turn=${turnId.slice(0, 8)}` : "";
    const detail = summarize(raw.method, payload);
    console.log(`  ${ts()} [${raw.kind}] ${raw.method}${turnTag}${detail}`);
  },
  onSessionChanged: () => {},
  onDisconnect: () => console.log(`  ${ts()} [ws] disconnected`),
  onReconnect: () => console.log(`  ${ts()} [ws] reconnected`),
});

function summarize(method: string, payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  if (method === "content/delta") {
    const delta = (payload.delta as string) ?? "";
    return ` δ="${delta.slice(0, 40)}"`;
  }
  if (method === "item/agentMessage/delta") {
    const delta = (payload.delta as string) ?? (payload.text as string) ?? "";
    return ` δ="${delta.slice(0, 40)}"`;
  }
  if (method === "turn/started" || method === "turn/completed") {
    const turn = payload.turn as Record<string, unknown> | undefined;
    return ` status=${(turn?.status as string) ?? (payload.stopReason as string) ?? "ok"}`;
  }
  if (method === "session/started" || method === "session/ready") {
    return "";
  }
  if (method.startsWith("codex/event/")) {
    const msg = payload.msg as Record<string, unknown> | undefined;
    const text = (msg?.text as string) ?? (msg?.last_agent_message as string) ?? "";
    return text ? ` "${text.slice(0, 50)}"` : "";
  }
  if (method === "item/completed" || method === "item/started") {
    const itemType = (payload.itemType as string) ?? ((payload.item as Record<string, unknown>)?.type as string) ?? "?";
    return ` type=${itemType}`;
  }
  return "";
}

async function run() {
  // 1. Connect
  console.log(`${ts()} Connecting...`);
  await mgr.connect();
  console.log(`${ts()} Connected\n`);

  // 2. Start session
  console.log(`${ts()} Starting ${provider} session...`);
  const session = await mgr.startSession({
    threadId,
    provider,
    cwd,
    runtimeMode: "full-access",
  });
  console.log(`${ts()} Session started: ${JSON.stringify(session)}\n`);

  // 3. Wait for session ready (some providers need time)
  console.log(`${ts()} Waiting for session ready...`);
  await new Promise((r) => setTimeout(r, 2000));

  // 4. Send turn
  console.log(`${ts()} Sending turn: "${prompt}"`);
  const turnResult = await mgr.sendTurn(threadId, {
    input: [{ type: "text", text: prompt }],
  });
  console.log(`${ts()} Turn accepted: ${JSON.stringify(turnResult)}\n`);

  // 5. Wait for turn completion
  console.log(`${ts()} Waiting for events (60s timeout)...\n`);
  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.log(`\n${ts()} TIMEOUT — turn did not complete in 60s`);
        resolve();
      }
    }, 60_000);

    // Check periodically if turn completed
    const check = setInterval(() => {
      const completed = events.find(
        (e) => e.method === "turn/completed" || e.method === "codex/event/task_complete",
      );
      if (completed && !settled) {
        settled = true;
        clearTimeout(timeout);
        clearInterval(check);
        // Give 2s for any trailing events
        setTimeout(resolve, 2000);
      }
    }, 500);
  });

  // 6. Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY: ${events.length} events received`);
  console.log(`${"=".repeat(60)}`);

  const methods = new Map<string, number>();
  for (const e of events) {
    methods.set(e.method, (methods.get(e.method) ?? 0) + 1);
  }
  for (const [method, count] of [...methods.entries()].sort()) {
    const turnIds = new Set(events.filter((e) => e.method === method && e.turnId).map((e) => e.turnId));
    const turnTag = turnIds.size > 0 ? ` (turnId: ${[...turnIds].map((t) => t!.slice(0, 8)).join(", ")})` : " (NO turnId)";
    console.log(`  ${method}: ${count}x${turnTag}`);
  }

  // 7. Write full event log
  const outPath = `/tmp/debug-${provider}-${Date.now()}.json`;
  await Bun.write(outPath, JSON.stringify(events, null, 2));
  console.log(`\nFull event log: ${outPath}`);

  // 8. Cleanup
  console.log(`\n${ts()} Stopping session...`);
  try {
    await mgr.stopSession(threadId);
  } catch {
    // ok if already stopped
  }
  mgr.disconnect();
  console.log(`${ts()} Done\n`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
