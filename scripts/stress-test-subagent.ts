#!/usr/bin/env bun
/**
 * stress-test-subagent.ts — GAP 1: Subagent tree stress test.
 *
 * Tests how well each runtime handles N concurrent sessions, each spawning
 * 3 subagents via plan mode. Measures event routing overhead, event
 * throughput, and the complexity of tracking subagent lifecycles.
 *
 * Node side: spawns mock-codex-server in subagent mode as child processes.
 *   The manager must parse and route all events through a single process.
 * Elixir side: uses harness with mock provider in subagent mode.
 *   Each session is a GenServer that independently handles its events.
 *
 * Usage:
 *   bun run scripts/stress-test-subagent.ts --runtime=node
 *   bun run scripts/stress-test-subagent.ts --runtime=elixir
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import v8 from "node:v8";

let HarnessClientManager: any;
try {
  const mod = await import("../apps/server/src/provider/Layers/HarnessClientManager.ts");
  HarnessClientManager = mod.HarnessClientManager;
} catch {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const RUNTIME = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1] || "node";
const HARNESS_PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const HARNESS_SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const N = 5; // concurrent sessions, each with 3 subagents = 15 subagent lifecycles
const DELTAS_PER_SESSION = 60; // split across 3 subagents (~20 each)
const DELTA_SIZE_KB = 5;
const DELAY_MS = 5;

mkdirSync(OUTPUT_DIR, { recursive: true });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

interface SubagentStats {
  sessionId: string;
  totalEvents: number;
  deltaEvents: number;
  subagentSpawns: number;
  subagentCompletions: number;
  interactionBegins: number;
  interactionEnds: number;
  turnsCompleted: number;
  totalPayloadBytes: number;
  errors: string[];
  firstEventAt: number | null;
  lastEventAt: number | null;
}

function createStats(sessionId: string): SubagentStats {
  return {
    sessionId,
    totalEvents: 0,
    deltaEvents: 0,
    subagentSpawns: 0,
    subagentCompletions: 0,
    interactionBegins: 0,
    interactionEnds: 0,
    turnsCompleted: 0,
    totalPayloadBytes: 0,
    errors: [],
    firstEventAt: null,
    lastEventAt: null,
  };
}

function trackEvent(stats: SubagentStats, method: string, payload: unknown) {
  stats.totalEvents++;
  const now = Date.now();
  if (!stats.firstEventAt) stats.firstEventAt = now;
  stats.lastEventAt = now;

  try { stats.totalPayloadBytes += JSON.stringify(payload).length; } catch {}

  switch (method) {
    case "item/agentMessage/delta":
      stats.deltaEvents++;
      break;
    case "collab_agent_spawn_begin":
      stats.subagentSpawns++;
      break;
    case "collab_agent_spawn_end":
      stats.subagentCompletions++;
      break;
    case "collab_agent_interaction_begin":
      stats.interactionBegins++;
      break;
    case "collab_agent_interaction_end":
      stats.interactionEnds++;
      break;
    case "turn/completed":
      stats.turnsCompleted++;
      break;
  }
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: SubagentStats[] = [];
  const lags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) lags.push(lag);
    lastLagCheck = now;
  }, 100);

  const sessions = new Map<string, {
    child: ChildProcessWithoutNullStreams;
    rl: readline.Interface;
    pending: Map<number, any>;
    nextId: number;
    codexThreadId: string | null;
  }>();

  // Start N sessions using mock-codex-server in subagent mode
  for (let i = 0; i < N; i++) {
    const sid = `subagent-node-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    const child = spawn("bun", [
      "run", "scripts/mock-codex-server.ts",
      String(DELTAS_PER_SESSION), String(DELTA_SIZE_KB), String(DELAY_MS), "subagent",
    ], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });

    const rl = readline.createInterface({ input: child.stdout });
    const session = { child, rl, pending: new Map<number, any>(), nextId: 1, codexThreadId: null as string | null };
    sessions.set(sid, session);

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = session.pending.get(msg.id);
          if (p) { session.pending.delete(msg.id); p.resolve(msg.result ?? msg.error); }
          return;
        }
        if (msg.method) trackEvent(stats, msg.method, msg.params);
      } catch {}
    });
    child.stderr?.resume();

    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 30000);
      session.pending.set(id, { resolve: (v: any) => { clearTimeout(timer); resolve(v); }, reject: (e: any) => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    try {
      await rpc("initialize", { clientInfo: { name: "stress", version: "1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", { cwd: process.cwd() });
      session.codexThreadId = threadResult?.thread?.id ?? null;
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  log(`${sessions.size} sessions ready, sending subagent tasks...`);

  // Send turns with plan mode to all sessions
  for (const stats of allStats) {
    const session = sessions.get(stats.sessionId);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 30000);
      session.pending.set(id, { resolve: (v: any) => { clearTimeout(timer); resolve(v); }, reject: (e: any) => { clearTimeout(timer); reject(e); } });
      session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: "Build microservices: auth, posts, comments. Delegate each to a subagent." }],
      collaborationMode: { mode: "plan" },
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for all to complete (max 60s)
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    await sleep(500);
  }

  clearInterval(lagTimer);

  for (const [, session] of sessions) {
    try { session.child.kill(); } catch {}
  }

  return { allStats, lags };
}

// ---------------------------------------------------------------------------
// Elixir runtime
// ---------------------------------------------------------------------------

async function runElixir() {
  const allStats: SubagentStats[] = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.sessionId === raw.threadId);
      if (stats) trackEvent(stats, raw.method, raw.payload);
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  // Baseline metrics
  const baseline = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/metrics`).then((r) => r.json()) as any;
  log(`Baseline: ${baseline.beam.process_count} processes, ${(baseline.beam.total_memory / 1024 / 1024).toFixed(1)}MB`);

  // Start N sessions with subagent mock mode
  for (let i = 0; i < N; i++) {
    const sid = `subagent-elixir-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: sid,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: {
          mock: { deltaCount: DELTAS_PER_SESSION, deltaSizeKb: DELTA_SIZE_KB, delayMs: DELAY_MS, mode: "subagent" },
        },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  log(`${allStats.filter((s) => s.errors.length === 0).length} sessions ready, sending subagent tasks...`);

  // Send turns
  for (const stats of allStats) {
    if (stats.errors.length > 0) continue;
    mgr.sendTurn(stats.sessionId, {
      input: [{ type: "text", text: "Build microservices: auth, posts, comments. Delegate each to a subagent." }],
      collaborationMode: { mode: "plan" },
    }).catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for all to complete (max 60s)
  const end = Date.now() + 60_000;
  const metricSnapshots: any[] = [];
  while (Date.now() < end) {
    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    try {
      const m = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/metrics`).then((r) => r.json());
      metricSnapshots.push(m);
    } catch {}
    await sleep(1000);
  }

  // Final metrics
  const postMetrics = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/metrics`).then((r) => r.json()) as any;
  const sessionData = (postMetrics.sessions ?? [])
    .filter((s: any) => String(s.thread_id ?? "").includes("subagent-elixir"))
    .map((s: any) => ({ memory: s.memory, gc_count: s.gc_count, reductions: s.reductions }));

  try { await mgr.stopAll(); } catch {}
  mgr.disconnect();

  return { allStats, lags: [] as number[], metricSnapshots, sessionData, postMetrics };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  GAP 1: Subagent Tree Stress Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  ${N} sessions × 3 subagents = ${N * 3} subagent lifecycles`.padEnd(58) + "║");
  console.log("║" + `  ${DELTAS_PER_SESSION} deltas/session × ${DELTA_SIZE_KB}KB`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  SUBAGENT STRESS TEST RESULTS");
  console.log("═".repeat(60));

  const { allStats, lags } = result;

  for (const stats of allStats) {
    console.log(`  [${stats.sessionId.slice(0, 30)}] events=${stats.totalEvents} deltas=${stats.deltaEvents} spawns=${stats.subagentSpawns} completions=${stats.subagentCompletions} turns=${stats.turnsCompleted}${stats.errors.length > 0 ? " ERRORS=" + stats.errors.length : ""}`);
  }

  const totalEvents = allStats.reduce((s, st) => s + st.totalEvents, 0);
  const totalDeltas = allStats.reduce((s, st) => s + st.deltaEvents, 0);
  const totalSpawns = allStats.reduce((s, st) => s + st.subagentSpawns, 0);
  const totalPayload = allStats.reduce((s, st) => s + st.totalPayloadBytes, 0);
  const duration = (completedAt - startedAt) / 1000;

  console.log(`\n  Total: ${totalEvents} events (${totalDeltas} deltas, ${totalSpawns} spawns), ${(totalPayload / 1024 / 1024).toFixed(1)}MB payload`);
  console.log(`  Duration: ${duration.toFixed(1)}s, Throughput: ${Math.round(totalEvents / duration)} events/s`);

  if (RUNTIME === "node" && lags.length > 0) {
    console.log(`  Event loop lag: p50=${percentile(lags, 50).toFixed(1)}ms p99=${percentile(lags, 99).toFixed(1)}ms max=${Math.max(...lags).toFixed(1)}ms`);
  }

  // Verify subagent lifecycle integrity
  const integrityOk = allStats.every((s) =>
    s.errors.length === 0 && s.subagentSpawns === 3 && s.subagentCompletions === 3 &&
    s.interactionBegins === 3 && s.interactionEnds === 3,
  );
  console.log(`\n  Subagent lifecycle integrity: ${integrityOk ? "PASS (3 spawns, 3 completions per session)" : "FAIL"}`);

  const output = {
    test: "subagent",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: { sessions: N, deltasPerSession: DELTAS_PER_SESSION, deltaSizeKb: DELTA_SIZE_KB, delayMs: DELAY_MS },
    sessions: allStats,
    summary: {
      sessionCount: N,
      completed: allStats.filter((s) => s.turnsCompleted > 0).length,
      totalEvents,
      totalDeltas,
      totalSubagentSpawns: totalSpawns,
      totalPayloadMb: Math.round(totalPayload / 1024 / 1024 * 10) / 10,
      eventsPerSecond: Math.round(totalEvents / duration),
      lifecycleIntegrity: integrityOk,
      ...(RUNTIME === "node" && lags.length > 0 ? {
        lagP50_ms: Math.round(percentile(lags, 50) * 10) / 10,
        lagP99_ms: Math.round(percentile(lags, 99) * 10) / 10,
        lagMax_ms: Math.round(Math.max(...lags) * 10) / 10,
      } : {}),
      ...("sessionData" in result ? { perSessionMetrics: (result as any).sessionData } : {}),
    },
  };

  const filename = `${RUNTIME}-subagent-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(60));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
