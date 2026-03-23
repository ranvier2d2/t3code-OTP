#!/usr/bin/env bun
/**
 * mock-codex-server.ts — Mock Codex app-server for controlled stress testing.
 *
 * Speaks the same JSON-RPC 2.0 stdio protocol as `codex app-server`.
 * Configurable payload sizes per delta to create controlled GC pressure
 * in the manager process that parses the JSON output.
 *
 * Usage (standalone — spawned as a child process by the test runner):
 *   bun run scripts/mock-codex-server.ts [delta_count] [delta_size_kb] [delay_ms] [mode]
 *
 * Modes:
 *   normal    — Default. Stream deltas and complete. (default)
 *   subagent  — Emit subagent collaboration events (collab_agent_spawn_begin/end,
 *               collab_agent_interaction_begin/end) with 3 subagents per turn.
 *   leak      — Never complete turns. Keep emitting deltas indefinitely to
 *               simulate a memory leak (state accumulation).
 *   crash     — Emit some deltas then exit with code 1 (simulate process crash).
 *
 * Environment:
 *   MOCK_DELTA_COUNT    Number of deltas per turn (default: 100)
 *   MOCK_DELTA_SIZE_KB  Size of each delta payload in KB (default: 1)
 *   MOCK_DELAY_MS       Delay between deltas in ms (default: 10)
 *   MOCK_MODE           Mode (default: normal)
 *
 * Protocol:
 *   Responds to: initialize, thread/start, turn/start, turn/interrupt, session/stop
 *   Emits: turn/started, item/agentMessage/delta (with configurable payload), turn/completed
 */

const DELTA_COUNT = Number(process.argv[2] || process.env.MOCK_DELTA_COUNT || 100);
const DELTA_SIZE_KB = Number(process.argv[3] || process.env.MOCK_DELTA_SIZE_KB || 1);
const DELAY_MS = Number(process.argv[4] || process.env.MOCK_DELAY_MS || 10);
const MODE = (process.argv[5] || process.env.MOCK_MODE || "normal") as "normal" | "subagent" | "leak" | "crash";

let threadCounter = 0;
let turnCounter = 0;
let activeTurn: { id: string; cancelled: boolean } | null = null;

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: unknown) {
  send({ jsonrpc: "2.0", method, params });
}

function generatePayload(sizeKb: number): string {
  // Generate a string of approximately sizeKb kilobytes.
  // Use varied content to prevent V8 string interning optimizations.
  const targetBytes = sizeKb * 1024;
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n";
  const segments: string[] = [];
  let totalLen = 0;

  while (totalLen < targetBytes) {
    // Each segment is unique to defeat dedup
    const seg = `[${turnCounter}-${totalLen}]` +
      Array.from({ length: 100 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    segments.push(seg);
    totalLen += seg.length;
  }

  return segments.join("").slice(0, targetBytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleTurnNormal(turnId: string) {
  for (let i = 0; i < DELTA_COUNT; i++) {
    if (activeTurn?.cancelled) return;
    sendNotification("item/agentMessage/delta", {
      delta: generatePayload(DELTA_SIZE_KB),
      turnId,
      itemId: `item-${turnId}-${i}`,
    });
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

async function handleTurnSubagent(turnId: string) {
  // Parent emits some deltas first (planning phase)
  for (let i = 0; i < 5; i++) {
    if (activeTurn?.cancelled) return;
    sendNotification("item/agentMessage/delta", {
      delta: `Planning subagent delegation for task ${i}...`,
      turnId,
      itemId: `item-${turnId}-plan-${i}`,
    });
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  // Spawn 3 subagents sequentially (matches real Codex behavior)
  const subagentNames = ["auth-service", "posts-service", "comments-service"];
  for (let s = 0; s < 3; s++) {
    if (activeTurn?.cancelled) return;
    const subagentId = `subagent-${turnId}-${s}`;
    const subagentName = subagentNames[s]!;

    // collab_agent_spawn_begin
    sendNotification("collab_agent_spawn_begin", {
      turnId,
      agentId: subagentId,
      agentName: subagentName,
      task: `Build the ${subagentName} microservice`,
    });

    // collab_agent_interaction_begin
    sendNotification("collab_agent_interaction_begin", {
      turnId,
      agentId: subagentId,
      agentName: subagentName,
    });

    // Subagent streams its own deltas (like a nested turn)
    const subDeltaCount = Math.floor(DELTA_COUNT / 3);
    for (let d = 0; d < subDeltaCount; d++) {
      if (activeTurn?.cancelled) return;
      sendNotification("item/agentMessage/delta", {
        delta: generatePayload(DELTA_SIZE_KB),
        turnId,
        itemId: `item-${subagentId}-${d}`,
        agentId: subagentId,
        agentName: subagentName,
      });
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }

    // collab_agent_interaction_end
    sendNotification("collab_agent_interaction_end", {
      turnId,
      agentId: subagentId,
      agentName: subagentName,
      result: "completed",
    });

    // collab_agent_spawn_end
    sendNotification("collab_agent_spawn_end", {
      turnId,
      agentId: subagentId,
      agentName: subagentName,
      status: "success",
    });
  }

  // Parent summarizes
  for (let i = 0; i < 3; i++) {
    if (activeTurn?.cancelled) return;
    sendNotification("item/agentMessage/delta", {
      delta: `Summary: All ${subagentNames.length} subagents completed.`,
      turnId,
      itemId: `item-${turnId}-summary-${i}`,
    });
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

async function handleTurnLeak(turnId: string) {
  // Never-ending stream — simulates a session that accumulates state.
  // Emits deltas indefinitely until interrupted or the process is killed.
  let i = 0;
  while (!activeTurn?.cancelled) {
    sendNotification("item/agentMessage/delta", {
      delta: generatePayload(DELTA_SIZE_KB),
      turnId,
      itemId: `item-${turnId}-${i}`,
    });
    i++;
    // Slower pace to avoid overwhelming the pipe
    await sleep(Math.max(DELAY_MS, 50));
  }
  // Turn is only "completed" via interrupt
}

async function handleTurnCrash(turnId: string) {
  // Emit some deltas, then crash
  const crashAfter = Math.min(10, DELTA_COUNT);
  for (let i = 0; i < crashAfter; i++) {
    if (activeTurn?.cancelled) return;
    sendNotification("item/agentMessage/delta", {
      delta: generatePayload(DELTA_SIZE_KB),
      turnId,
      itemId: `item-${turnId}-${i}`,
    });
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  // Simulate unexpected crash
  process.exit(1);
}

async function handleTurnStart(id: number | string, params: Record<string, unknown>) {
  turnCounter++;
  const turnId = `mock-turn-${turnCounter}-${Date.now()}`;
  activeTurn = { id: turnId, cancelled: false };

  sendResponse(id, {
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  });

  sendNotification("turn/started", {
    turn: { id: turnId, status: "running" },
  });

  switch (MODE) {
    case "subagent":
      await handleTurnSubagent(turnId);
      break;
    case "leak":
      await handleTurnLeak(turnId);
      break;
    case "crash":
      await handleTurnCrash(turnId);
      break;
    default:
      await handleTurnNormal(turnId);
      break;
  }

  if (!activeTurn?.cancelled) {
    sendNotification("turn/completed", {
      turn: { id: turnId, status: "completed", error: null },
    });
  }

  activeTurn = null;
}

// Read stdin line by line
const reader = require("readline").createInterface({ input: process.stdin });

reader.on("line", async (line: string) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const id = msg.id as number | string | undefined;
  const method = msg.method as string;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      sendResponse(id!, {
        serverInfo: { name: "mock-codex-server", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "initialized":
      // Client notification — no response needed
      break;

    case "thread/start":
      threadCounter++;
      sendResponse(id!, {
        thread: { id: `mock-thread-${threadCounter}` },
      });
      // Emit thread/started like real Codex
      sendNotification("thread/started", {
        thread: { id: `mock-thread-${threadCounter}` },
      });
      break;

    case "turn/start":
      // Handle asynchronously so we can stream deltas
      handleTurnStart(id!, params);
      break;

    case "turn/interrupt":
      if (activeTurn) {
        activeTurn.cancelled = true;
        sendNotification("turn/completed", {
          turn: { id: activeTurn.id, status: "cancelled", error: null },
        });
      }
      sendResponse(id!, { ok: true });
      break;

    case "model/list":
      sendResponse(id!, { models: [{ id: "mock-model" }] });
      break;

    case "account/read":
      sendResponse(id!, { type: "chatgpt", planType: "pro" });
      break;

    default:
      if (id !== undefined && id !== null) {
        sendResponse(id, { ok: true });
      }
      break;
  }
});

// Keep alive
process.stdin.resume();
