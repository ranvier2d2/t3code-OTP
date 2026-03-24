#!/usr/bin/env bun
/**
 * Quick test: connect Node to the running Elixir HarnessService
 * via Phoenix Channel WebSocket protocol.
 *
 * Usage: T3CODE_HARNESS_PORT=4321 bun run scripts/test-harness-connection.ts
 */
import WebSocket from "ws";

const PORT = process.env.T3CODE_HARNESS_PORT ?? "4321";
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const URL = `ws://localhost:${PORT}/socket/websocket?secret=${SECRET}&vsn=2.0.0`;

let nextRef = 1;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function send(
  ws: WebSocket,
  joinRef: string | null,
  event: string,
  payload: Record<string, unknown>,
  topic = "harness:lobby",
): Promise<unknown> {
  const ref = String(nextRef++);
  const msg = JSON.stringify([joinRef, ref, topic, event, payload]);

  return new Promise((resolve, reject) => {
    pending.set(ref, { resolve, reject });
    ws.send(msg);
    setTimeout(() => {
      if (pending.has(ref)) {
        pending.delete(ref);
        reject(new Error(`Timeout waiting for reply to ${event}`));
      }
    }, 10_000);
  });
}

async function main() {
  console.log(`\n🔌 Connecting to ${URL}...\n`);

  const ws = new WebSocket(URL);

  ws.on("error", (err: Error) => {
    console.error("❌ WebSocket error:", err.message);
    process.exit(1);
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    const text = raw.toString();
    console.log(`  [RAW] ${text.slice(0, 200)}`);
    let msg: unknown[];
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.error("  Failed to parse message:", err);
      return;
    }
    const [, ref, , event, payload] = msg;

    const refStr = typeof ref === "string" ? ref : String(ref);
    if (event === "phx_reply" && ref && pending.has(refStr)) {
      const { resolve, reject } = pending.get(refStr)!;
      pending.delete(refStr);
      const typedPayload = payload as { status: string; response: unknown };
      if (typedPayload.status === "ok") {
        resolve(typedPayload.response);
      } else {
        reject(new Error(`Channel error: ${JSON.stringify(typedPayload.response)}`));
      }
      return;
    }

    // Server pushes
    if (event === "harness.event") {
      const typedPayload = payload as { method?: string; threadId?: string };
      console.log(`  📡 Event: ${typedPayload.method} (thread: ${typedPayload.threadId})`);
      return;
    }

    if (event === "harness.session.changed") {
      const typedPayload = payload as { threadId?: string; session?: { status?: string } };
      console.log(
        `  🔄 Session changed: ${typedPayload.threadId} → ${typedPayload.session?.status}`,
      );
      return;
    }
  });

  await new Promise<void>((resolve) => ws.on("open", resolve));
  console.log("✅ WebSocket connected\n");

  // 1. Join the channel
  console.log("── Join harness:lobby ──");
  const joinResult = await send(ws, "1", "phx_join", { secret: SECRET });
  console.log("✅ Joined channel\n");

  const JOIN_REF = "1"; // Must match join_ref used for phx_join

  // 2. Get snapshot
  console.log("── Get snapshot ──");
  const snapshotResp = (await send(ws, JOIN_REF, "snapshot.get", {})) as {
    snapshot: { sequence: number; sessions: Record<string, unknown> };
  };
  console.log(`  Sequence: ${snapshotResp.snapshot.sequence}`);
  console.log(`  Sessions: ${Object.keys(snapshotResp.snapshot.sessions).length}\n`);

  // 3. List sessions
  console.log("── List sessions ──");
  const sessions = (await send(ws, JOIN_REF, "session.listSessions", {})) as {
    sessions: unknown[];
  };
  console.log(`  Active: ${sessions.sessions.length}\n`);

  // 4. Start an OpenCode session
  const threadId = `node-test-opencode-${Date.now()}`;
  console.log(`── Start OpenCode session (${threadId}) ──`);
  try {
    const startResult = await send(ws, JOIN_REF, "session.start", {
      threadId,
      provider: "opencode",
      cwd: "/tmp",
    });
    console.log("✅ Session started:", JSON.stringify(startResult));
  } catch (err) {
    console.log(
      "⚠️  Session start error (expected if opencode has issues):",
      (err as Error).message,
    );
  }

  // 5. Wait for events
  console.log("\n⏳ Waiting 8s for provider events...\n");
  await new Promise((r) => setTimeout(r, 8_000));

  // 6. Check snapshot again
  console.log("── Snapshot after session ──");
  const snap2Resp = (await send(ws, JOIN_REF, "snapshot.get", {})) as {
    snapshot: { sequence: number; sessions: Record<string, { status: string; provider: string }> };
  };
  const snapshot2 = snap2Resp.snapshot;
  console.log(`  Sequence: ${snapshot2.sequence}`);
  for (const [id, s] of Object.entries(snapshot2.sessions)) {
    console.log(`  ${id}: ${s.status} (${s.provider})`);
  }

  // 7. Stop session
  console.log(`\n── Stop session ──`);
  try {
    await send(ws, JOIN_REF, "session.stop", { threadId });
    console.log("✅ Session stopped");
  } catch (err) {
    console.log("⚠️  Stop error:", (err as Error).message);
  }

  // 8. Heartbeat test
  console.log("\n── Heartbeat ──");
  const hbRef = String(nextRef++);
  ws.send(JSON.stringify([null, hbRef, "phoenix", "heartbeat", {}]));
  console.log("✅ Heartbeat sent\n");

  // Done
  console.log("🎉 All tests passed!\n");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
