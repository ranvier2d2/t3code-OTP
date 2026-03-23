#!/usr/bin/env bun
/**
 * stress-test-scale50.ts — GAP 3: 50-session scale test.
 *
 * Scales up the concurrent session test from 10 → 50 sessions.
 * All sessions use the mock provider (200 × 1KB deltas).
 * Measures throughput per-session, event loop lag (Node), scheduler
 * utilization (Elixir), and overall system behavior under load.
 *
 * Usage:
 *   bun run scripts/stress-test-scale50.ts --runtime=node
 *   bun run scripts/stress-test-scale50.ts --runtime=elixir
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
const N = 50;
const DELTA_COUNT = 200;
const DELTA_SIZE_KB = 1;
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

interface SessionStats {
  id: string;
  deltaCount: number;
  turnsCompleted: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  errors: string[];
}

function createStats(id: string): SessionStats {
  return { id, deltaCount: 0, turnsCompleted: 0, firstDeltaAt: null, lastDeltaAt: null, errors: [] };
}

// ---------------------------------------------------------------------------
// Node runtime — 50 child processes, single manager
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];

  // Event loop lag
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

  // Spawn 50 mock sessions
  log(`Starting ${N} mock child processes...`);
  const startPhaseStart = Date.now();

  for (let i = 0; i < N; i++) {
    const sid = `scale50-node-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    const child = spawn("bun", [
      "run", "scripts/mock-codex-server.ts",
      String(DELTA_COUNT), String(DELTA_SIZE_KB), String(DELAY_MS), "normal",
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
        if (msg.method === "item/agentMessage/delta") {
          stats.deltaCount++;
          const now = Date.now();
          eventTimestamps.push(now);
          if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
          stats.lastDeltaAt = now;
        }
        if (msg.method === "turn/completed") stats.turnsCompleted++;
      } catch {}
    });
    child.stderr?.resume();

    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 30000);
      session.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v); },
        reject: (e: any) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    try {
      await rpc("initialize", { clientInfo: { name: "stress", version: "1.0" }, capabilities: {} });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", { cwd: process.cwd() });
      session.codexThreadId = threadResult?.thread?.id ?? null;
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }

    // Log progress every 10 sessions
    if ((i + 1) % 10 === 0) log(`  ${i + 1}/${N} sessions started`);
  }

  const startupDuration = (Date.now() - startPhaseStart) / 1000;
  log(`All ${N} sessions started in ${startupDuration.toFixed(1)}s`);

  // Heap snapshot before sending
  const preHeap = process.memoryUsage();
  log(`Pre-send heap: ${(preHeap.heapUsed / 1024 / 1024).toFixed(1)}MB`);

  // Send turns to ALL simultaneously
  log("Sending turns to all 50 sessions...");
  for (const stats of allStats) {
    const session = sessions.get(stats.id);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 60000);
      session.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timer); resolve(v); },
        reject: (e: any) => { clearTimeout(timer); reject(e); },
      });
      session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: "scale50 test" }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for completion (max 2 min)
  const end = Date.now() + 120_000;
  const metricSnapshots: Array<{ elapsed_ms: number; heapUsed: number; rss: number; completed: number; totalDeltas: number }> = [];
  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
    const mem = process.memoryUsage();
    metricSnapshots.push({ elapsed_ms: Date.now() - t0, heapUsed: mem.heapUsed, rss: mem.rss, completed, totalDeltas });

    if (completed === allStats.length || allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;
    process.stdout.write(`\r  ${ts()} completed=${completed}/${N} deltas=${totalDeltas} heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
    await sleep(1000);
  }

  clearInterval(lagTimer);
  console.log("");

  // Kill all
  for (const [, session] of sessions) {
    try { session.child.kill(); } catch {}
  }

  return { allStats, eventTimestamps, lags, metricSnapshots, startupDuration };
}

// ---------------------------------------------------------------------------
// Elixir runtime — 50 GenServer processes
// ---------------------------------------------------------------------------

async function runElixir() {
  const allStats: SessionStats[] = [];
  const eventTimestamps: number[] = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;
      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        const now = Date.now();
        eventTimestamps.push(now);
        if (!stats.firstDeltaAt) stats.firstDeltaAt = now;
        stats.lastDeltaAt = now;
      }
      if (raw.method === "turn/completed") stats.turnsCompleted++;
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;
  const baseline = await fetch(METRICS_URL).then((r) => r.json()) as any;
  log(`Baseline: ${baseline.beam.process_count} processes, ${(baseline.beam.total_memory / 1024 / 1024).toFixed(1)}MB`);

  // Start 50 mock sessions
  log(`Starting ${N} sessions...`);
  const startPhaseStart = Date.now();

  for (let i = 0; i < N; i++) {
    const sid = `scale50-elixir-${i}-${Date.now()}`;
    const stats = createStats(sid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: sid,
        provider: "mock",
        cwd: process.cwd(),
        providerOptions: { mock: { deltaCount: DELTA_COUNT, deltaSizeKb: DELTA_SIZE_KB, delayMs: DELAY_MS } },
      });
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
    }

    if ((i + 1) % 10 === 0) log(`  ${i + 1}/${N} sessions started`);
  }

  const startupDuration = (Date.now() - startPhaseStart) / 1000;
  log(`All ${N} sessions started in ${startupDuration.toFixed(1)}s`);

  const preMetrics = await fetch(METRICS_URL).then((r) => r.json()) as any;
  log(`After start: ${preMetrics.beam.process_count} processes, ${(preMetrics.beam.total_memory / 1024 / 1024).toFixed(1)}MB`);

  // Send turns to ALL simultaneously
  log("Sending turns to all 50 sessions...");
  const turnPromises = allStats
    .filter((s) => s.errors.length === 0)
    .map((s) => mgr.sendTurn(s.id, { input: [{ type: "text", text: "scale50 test" }] }).catch(() => {}));
  await Promise.all(turnPromises);
  log("All turns accepted");

  // Wait for completion
  const end = Date.now() + 120_000;
  const metricSnapshots: any[] = [];
  while (Date.now() < end) {
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
    if (completed >= N || allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) break;

    try {
      const m = await fetch(METRICS_URL).then((r) => r.json()) as any;
      metricSnapshots.push(m);
      process.stdout.write(`\r  ${ts()} completed=${completed}/${N} deltas=${totalDeltas} mem=${(m.beam.total_memory / 1024 / 1024).toFixed(1)}MB procs=${m.beam.process_count}`);
    } catch {}
    await sleep(1000);
  }

  console.log("");

  // Final metrics
  const postMetrics = await fetch(METRICS_URL).then((r) => r.json()) as any;
  const sessionData = (postMetrics.sessions ?? [])
    .filter((s: any) => String(s.thread_id ?? "").includes("scale50-elixir"))
    .map((s: any) => ({ memory: s.memory, gc_count: s.gc_count, reductions: s.reductions }));

  try { await mgr.stopAll(); } catch {}
  mgr.disconnect();

  return { allStats, eventTimestamps, lags: [] as number[], metricSnapshots, startupDuration, sessionData, postMetrics };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  GAP 3: 50-Session Scale Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  ${N} sessions × ${DELTA_COUNT} deltas × ${DELTA_SIZE_KB}KB`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log("  50-SESSION SCALE TEST RESULTS");
  console.log("═".repeat(60));

  const { allStats, eventTimestamps, lags } = result;
  const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
  const totalDeltas = allStats.reduce((s, st) => s + st.deltaCount, 0);
  const errors = allStats.filter((s) => s.errors.length > 0).length;
  const duration = (completedAt - startedAt) / 1000;

  console.log(`  Sessions: ${completed}/${N} completed, ${errors} errors`);
  console.log(`  Total deltas: ${totalDeltas} (expected: ${N * DELTA_COUNT})`);
  console.log(`  Startup: ${result.startupDuration.toFixed(1)}s`);
  console.log(`  Total duration: ${duration.toFixed(1)}s`);

  // Throughput
  if (eventTimestamps.length > 1) {
    const streamDur = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    console.log(`  Throughput: ${Math.round(eventTimestamps.length / streamDur)} events/s over ${streamDur.toFixed(1)}s`);
  }

  // Per-session fairness (stddev of delta counts)
  const counts = allStats.map((s) => s.deltaCount);
  const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
  const stddev = Math.sqrt(counts.reduce((s, c) => s + (c - avg) ** 2, 0) / counts.length);
  console.log(`  Fairness: avg=${avg.toFixed(0)} deltas/session, stddev=${stddev.toFixed(1)}`);

  if (RUNTIME === "node" && lags.length > 0) {
    console.log(`  Event loop lag: p50=${percentile(lags, 50).toFixed(1)}ms p99=${percentile(lags, 99).toFixed(1)}ms max=${Math.max(...lags).toFixed(1)}ms`);
  }

  if (RUNTIME === "elixir" && "sessionData" in result) {
    const sd = (result as any).sessionData as Array<{ memory: number; gc_count: number }>;
    if (sd.length > 0) {
      const avgMem = sd.reduce((s, m) => s + m.memory, 0) / sd.length;
      const avgGc = sd.reduce((s, m) => s + m.gc_count, 0) / sd.length;
      console.log(`  Per-session avg: mem=${(avgMem / 1024).toFixed(1)}KB, gc=${avgGc.toFixed(0)}`);
    }
    const pm = (result as any).postMetrics;
    if (pm?.beam?.scheduler_utilization) {
      const sched = pm.beam.scheduler_utilization;
      if (Array.isArray(sched)) {
        const avgUtil = sched.reduce((s: number, u: number) => s + u, 0) / sched.length;
        console.log(`  Scheduler utilization: avg=${(avgUtil * 100).toFixed(1)}%, max=${(Math.max(...sched) * 100).toFixed(1)}%`);
      }
    }
  }

  const output = {
    test: "scale50",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: { sessions: N, deltaCount: DELTA_COUNT, deltaSizeKb: DELTA_SIZE_KB, delayMs: DELAY_MS },
    sessions: allStats,
    metricSnapshots: result.metricSnapshots,
    summary: {
      sessionCount: N,
      completed,
      totalDeltas,
      errors,
      startupDuration_s: result.startupDuration,
      totalDuration_s: duration,
      eventsPerSecond: eventTimestamps.length > 1
        ? Math.round(eventTimestamps.length / ((eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000))
        : 0,
      fairnessStddev: Math.round(stddev * 10) / 10,
      ...(RUNTIME === "node" && lags.length > 0 ? {
        lagP50_ms: Math.round(percentile(lags, 50) * 10) / 10,
        lagP99_ms: Math.round(percentile(lags, 99) * 10) / 10,
        lagMax_ms: Math.round(Math.max(...lags) * 10) / 10,
      } : {}),
      ...("sessionData" in result ? { perSessionMetrics: (result as any).sessionData } : {}),
    },
  };

  const filename = `${RUNTIME}-scale50-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(60));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
