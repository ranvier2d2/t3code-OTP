#!/usr/bin/env bun
/**
 * Send a real prompt to a provider through the Elixir harness
 * and watch events stream back in real-time.
 *
 * Usage:
 *   bun run scripts/test-harness-prompt.ts claude "What is 2+2?"
 *   bun run scripts/test-harness-prompt.ts opencode "List files in /tmp"
 *   bun run scripts/test-harness-prompt.ts codex "Hello"
 *   bun run scripts/test-harness-prompt.ts cursor "Hello"
 */
import WebSocket from "ws";

const PORT = process.env.T3CODE_HARNESS_PORT ?? "4321";
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const URL = `ws://localhost:${PORT}/socket/websocket?secret=${SECRET}&vsn=2.0.0`;

const PROVIDER = process.argv[2] ?? "claudeAgent";
const PROMPT = process.argv[3] ?? "Say hello in one sentence.";
const CWD = process.argv[4] ?? process.cwd();
const JOIN_REF = "1";

let nextRef = 1;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let eventCount = 0;
let assistantText = "";

function send(ws: WebSocket, event: string, payload: Record<string, unknown>): Promise<unknown> {
  const ref = String(nextRef++);
  const msg = JSON.stringify([JOIN_REF, ref, "harness:lobby", event, payload]);
  return new Promise((resolve, reject) => {
    pending.set(ref, { resolve, reject });
    ws.send(msg);
    setTimeout(() => {
      if (pending.has(ref)) {
        pending.delete(ref);
        reject(new Error(`Timeout: ${event}`));
      }
    }, 30_000);
  });
}

function formatEvent(payload: Record<string, unknown>): string {
  const method = (payload.method as string) ?? "?";
  const kind = (payload.kind as string) ?? "?";
  const inner = payload.payload as Record<string, unknown> | undefined;

  // Content delta — show the text
  if (method === "content/delta" && inner) {
    const delta = (inner.delta as string) ?? "";
    const streamKind = (inner.streamKind as string) ?? "";
    if (streamKind === "assistant_text") {
      assistantText += delta;
      return `\x1b[32m${delta}\x1b[0m`;
    }
    if (streamKind === "reasoning_text") {
      return `\x1b[33m[thinking] ${delta}\x1b[0m`;
    }
    return `[${streamKind}] ${delta}`;
  }

  // Turn events
  if (method.startsWith("turn/")) {
    const turn = inner?.turn as Record<string, unknown> | undefined;
    return `\x1b[36m[${method}]\x1b[0m ${turn?.status ?? turn?.id ?? ""}`;
  }

  // Session events
  if (method.startsWith("session/")) {
    return `\x1b[34m[${method}]\x1b[0m ${JSON.stringify(inner ?? {}).slice(0, 100)}`;
  }

  // Item events (tool use)
  if (method.startsWith("item/")) {
    const toolName = (inner?.toolName as string) ?? "";
    const itemType = (inner?.itemType as string) ?? "";
    return `\x1b[35m[${method}]\x1b[0m ${itemType} ${toolName}`.trim();
  }

  // Request events (approvals)
  if (method.startsWith("request/")) {
    const requestType = (inner?.requestType as string) ?? "";
    const detail = (inner?.detail as string) ?? "";
    return `\x1b[31m[${method}]\x1b[0m ${requestType} — ${detail}`;
  }

  // Default
  return `[${kind}:${method}] ${JSON.stringify(inner ?? {}).slice(0, 80)}`;
}

async function main() {
  console.log(`\n🔌 Connecting to harness on port ${PORT}...`);
  console.log(`📦 Provider: ${PROVIDER}`);
  console.log(`💬 Prompt: "${PROMPT}"`);
  console.log(`📁 CWD: ${CWD}\n`);

  const ws = new WebSocket(URL);

  ws.on("error", (err: Error) => {
    console.error("❌ WebSocket error:", err.message);
    process.exit(1);
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    const msg = JSON.parse(raw.toString());
    const [, ref, , event, payload] = msg as [
      string | null,
      string | null,
      string,
      string,
      Record<string, unknown>,
    ];

    // Handle replies
    if (event === "phx_reply" && ref && pending.has(ref)) {
      const { resolve, reject } = pending.get(ref)!;
      pending.delete(ref);
      const p = payload as { status: string; response: unknown };
      if (p.status === "ok") resolve(p.response);
      else reject(new Error(JSON.stringify(p.response)));
      return;
    }

    // Handle events
    if (event === "harness.event") {
      eventCount++;
      const formatted = formatEvent(payload);
      if (formatted.length > 0) {
        // Content deltas print inline (no newline for streaming effect)
        const method = payload.method as string;
        if (method === "content/delta") {
          process.stdout.write(formatted);
        } else {
          console.log(`  ${formatted}`);
        }
      }
      return;
    }

    if (event === "harness.session.changed") {
      const p = payload as { threadId?: string; session?: { status?: string } };
      console.log(`  \x1b[34m[session.changed]\x1b[0m ${p.session?.status}`);
    }
  });

  await new Promise<void>((r) => ws.on("open", r));

  // Join
  await send(ws, "phx_join", { secret: SECRET });
  console.log("✅ Connected to harness\n");

  // Start session
  const threadId = `prompt-${PROVIDER}-${Date.now()}`;
  console.log(`── Starting ${PROVIDER} session ──`);
  const startResp = (await send(ws, "session.start", {
    threadId,
    provider: PROVIDER,
    cwd: CWD,
    model: PROVIDER === "claudeAgent" ? "claude-sonnet-4-6" : undefined,
  })) as { session: { status: string } };
  console.log(`  Session: ${startResp.session.status}\n`);

  // Wait for session to be ready
  console.log("⏳ Waiting for session ready...");
  await new Promise((r) => setTimeout(r, 5_000));

  // Send turn
  console.log(`\n── Sending prompt: "${PROMPT}" ──\n`);
  try {
    const turnResp = await send(ws, "session.sendTurn", {
      threadId,
      input: [{ type: "text", text: PROMPT }],
    });
    console.log(`\n  Turn started: ${JSON.stringify(turnResp)}`);
  } catch (err) {
    console.log(`\n  ⚠️ Turn error: ${(err as Error).message}`);
  }

  // Stream events until idle
  console.log("\n⏳ Streaming events...\n");

  let lastEventCount = eventCount;
  let idleSeconds = 0;

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (eventCount === lastEventCount) {
      idleSeconds++;
      if (idleSeconds >= 15) {
        console.log("\n\n  (no events for 15s — assuming done)");
        break;
      }
    } else {
      idleSeconds = 0;
      lastEventCount = eventCount;
    }
  }

  // Summary
  console.log(`\n\n── Summary ──`);
  console.log(`  Total events: ${eventCount}`);
  if (assistantText) {
    console.log(
      `  Assistant response: "${assistantText.slice(0, 200)}${assistantText.length > 200 ? "..." : ""}"`,
    );
  }

  // Get final snapshot
  const snap = (await send(ws, "snapshot.get", {})) as {
    snapshot: { sequence: number; sessions: Record<string, { status: string }> };
  };
  const session = snap.snapshot.sessions[threadId];
  if (session) {
    console.log(`  Session status: ${session.status}`);
  }

  // Cleanup
  try {
    await send(ws, "session.stop", { threadId });
  } catch {}

  console.log("\n🏁 Done!\n");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("💥", err.message);
  process.exit(1);
});
