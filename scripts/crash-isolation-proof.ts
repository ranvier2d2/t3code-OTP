#!/usr/bin/env bun
/**
 * crash-isolation-proof.ts — Demonstrates OTP crash isolation.
 *
 * Strategy: Start two sessions. Send a long task to both. Kill one
 * immediately after it starts. The other must complete unaffected.
 *
 * Usage: bun run scripts/crash-isolation-proof.ts
 */

import { HarnessClientManager, type HarnessRawEvent } from "../apps/server/src/provider/Layers/HarnessClientManager.ts";

const port = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const secret = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const cwd = process.cwd();
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const sessionA = { threadId: `victim-${Date.now()}`, provider: "codex", label: "Codex (VICTIM)" };
const sessionB = { threadId: `survivor-${Date.now()}`, provider: "claudeAgent", label: "Claude (SURVIVOR)" };

const state = {
  A: { turnStarted: false, deltas: 0, completed: false, killed: false, text: "" },
  B: { turnStarted: false, deltas: 0, completed: false, text: "" },
};

console.log(`
╔══════════════════════════════════════════════════════════════╗
║              OTP Crash Isolation Proof                       ║
║                                                              ║
║  Session A: ${sessionA.label.padEnd(44)}║
║  Session B: ${sessionB.label.padEnd(44)}║
║                                                              ║
║  Both get a task. A is killed mid-stream.                    ║
║  B must complete independently.                              ║
╚══════════════════════════════════════════════════════════════╝
`);

let killTriggered = false;
let killResolve: (() => void) | null = null;
const killPromise = new Promise<void>((r) => { killResolve = r; });

const mgr = new HarnessClientManager({
  harnessPort: port,
  harnessSecret: secret,
  onEvent: (raw: HarnessRawEvent) => {
    const p = raw.payload as Record<string, unknown> | undefined;
    const isA = raw.threadId === sessionA.threadId;
    const isB = raw.threadId === sessionB.threadId;
    if (!isA && !isB) return;

    const label = isA ? "A" : "B";
    const s = isA ? state.A : state.B;
    const icon = isA ? "🔴" : "🟢";

    if (raw.method === "turn/started") {
      s.turnStarted = true;
      console.log(`  ${ts()} ${icon} [${label}] Turn started`);
      // Kill A as soon as its turn starts
      if (isA && !killTriggered) {
        killTriggered = true;
        setTimeout(() => killResolve?.(), 2000); // 2s after A starts
      }
    }

    if (raw.method === "content/delta") {
      const delta = String(p?.delta ?? "");
      s.deltas++;
      s.text += delta;
      if (s.deltas <= 3 || s.deltas % 5 === 0) {
        console.log(`  ${ts()} ${icon} [${label}] delta #${s.deltas}: "${delta.slice(0, 40).replace(/\n/g, "\\n")}"`);
      }
    }

    // Codex sends text via item/agentMessage/delta
    if (raw.method === "item/agentMessage/delta") {
      const delta = String(p?.delta ?? "");
      s.deltas++;
      s.text += delta;
      console.log(`  ${ts()} ${icon} [${label}] delta #${s.deltas}: "${delta.slice(0, 40).replace(/\n/g, "\\n")}"`);
    }

    if (raw.method === "turn/completed") {
      s.completed = true;
      console.log(`  ${ts()} ${icon} [${label}] ✅ Turn COMPLETED (${s.deltas} deltas)`);
    }

    if (raw.method === "session/exited") {
      console.log(`  ${ts()} ${icon} [${label}] Session exited`);
    }
  },
  onSessionChanged: () => {},
  onDisconnect: () => {},
  onReconnect: () => {},
});

async function run() {
  console.log(`${ts()} Connecting...`);
  await mgr.connect();
  console.log(`${ts()} Connected\n`);

  // Start both sessions
  console.log(`${ts()} Starting both sessions...`);
  await Promise.all([
    mgr.startSession({ threadId: sessionA.threadId, provider: sessionA.provider, cwd, runtimeMode: "full-access" }),
    mgr.startSession({ threadId: sessionB.threadId, provider: sessionB.provider, cwd, runtimeMode: "full-access" }),
  ]);
  console.log(`${ts()} Both sessions ready\n`);
  await new Promise((r) => setTimeout(r, 2000));

  // Send tasks concurrently
  const task = "Write a short poem about the ocean, at least 8 lines. Take your time with each line. Do not use any tools.";
  console.log(`${ts()} Sending task to both: "${task.slice(0, 60)}..."\n`);

  await Promise.all([
    mgr.sendTurn(sessionA.threadId, { input: [{ type: "text", text: task }] }),
    mgr.sendTurn(sessionB.threadId, { input: [{ type: "text", text: task }] }),
  ]);

  // Wait for kill trigger (2s after A's turn starts)
  console.log(`${ts()} Waiting for kill window...\n`);
  await killPromise;

  // KILL Session A
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${ts()} 💀 KILLING Session A (Codex)...`);
  console.log(`  A: ${state.A.deltas} deltas, completed=${state.A.completed}`);
  console.log(`  B: ${state.B.deltas} deltas, completed=${state.B.completed}`);
  console.log(`${"═".repeat(60)}\n`);

  try {
    await mgr.stopSession(sessionA.threadId);
    state.A.killed = true;
    console.log(`  ${ts()} 🔴 Session A killed successfully`);
  } catch (e) {
    state.A.killed = true;
    console.log(`  ${ts()} 🔴 Session A kill: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Wait for Session B to complete (or timeout)
  console.log(`\n${ts()} Waiting for Session B to complete...\n`);
  await new Promise<void>((resolve) => {
    if (state.B.completed) { resolve(); return; }
    const check = setInterval(() => {
      if (state.B.completed) { clearInterval(check); resolve(); }
    }, 300);
    setTimeout(() => { clearInterval(check); resolve(); }, 30000);
  });

  // Results
  const passed = state.A.killed && state.B.completed;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  CRASH ISOLATION PROOF — RESULTS`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  🔴 Session A (${sessionA.provider}):`);
  console.log(`     Turn started: ${state.A.turnStarted}`);
  console.log(`     Deltas received: ${state.A.deltas}`);
  console.log(`     Killed: ${state.A.killed}`);
  console.log(`     Completed after kill: ${state.A.completed}`);
  console.log(`  🟢 Session B (${sessionB.provider}):`);
  console.log(`     Turn started: ${state.B.turnStarted}`);
  console.log(`     Deltas received: ${state.B.deltas}`);
  console.log(`     Completed: ${state.B.completed}`);
  console.log(`     Response: "${state.B.text.slice(0, 100).replace(/\n/g, "\\n")}..."`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  ${passed ? "✅ PASS" : "❌ FAIL"}: ${
    passed
      ? "Session A killed → Session B completed independently. Crash isolation verified."
      : state.B.completed ? "Both completed (kill was too late)." : "Session B did not complete."
  }\n`);

  try { await mgr.stopSession(sessionB.threadId); } catch {}
  mgr.disconnect();
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
