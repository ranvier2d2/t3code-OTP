#!/usr/bin/env bun
/**
 * stress-test-concurrent-elixir.ts — 10 concurrent sessions via Elixir harness.
 *
 * All sessions use the mock provider (200 × 10KB deltas).
 * Measures event throughput, per-process memory/GC, and SnapshotServer queue.
 *
 * Prerequisites: Elixir harness running with mock provider on port 4321.
 */

import { HarnessClientManager, type HarnessRawEvent } from "../apps/server/src/provider/Layers/HarnessClientManager.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const METRICS_URL = `http://127.0.0.1:${PORT}/api/metrics`;
const CWD = process.cwd();
const N = 10;

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
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  CONCURRENT: 10 sessions × 200 deltas × 10KB");
  console.log("  Elixir harness — per-GenServer processes");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const sessionIds: string[] = [];
  const states = new Map<string, { deltas: number; turnsCompleted: number }>();
  const eventTimestamps: number[] = [];

  const mgr = new HarnessClientManager({
    harnessPort: PORT,
    harnessSecret: SECRET,
    onEvent: (raw: HarnessRawEvent) => {
      const state = states.get(raw.threadId);
      if (!state) return;
      if (raw.method === "item/agentMessage/delta") {
        state.deltas++;
        eventTimestamps.push(Date.now());
      }
      if (raw.method === "turn/completed") state.turnsCompleted++;
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected");

  // Baseline metrics
  const baseline = await fetch(METRICS_URL).then((r) => r.json()) as Record<string, unknown>;
  const baseBeam = baseline.beam as Record<string, unknown>;
  log(`Baseline: ${baseBeam.process_count} processes, ${((baseBeam.total_memory as number) / 1024 / 1024).toFixed(1)}MB`);

  // Start 10 mock sessions
  for (let i = 0; i < N; i++) {
    const tid = `concurrent-elixir-${i}-${Date.now()}`;
    sessionIds.push(tid);
    states.set(tid, { deltas: 0, turnsCompleted: 0 });

    await mgr.startSession({
      threadId: tid,
      provider: "mock",
      cwd: CWD,
      providerOptions: { mock: { deltaCount: 200, deltaSizeKb: 10, delayMs: 5 } },
    });
  }
  log(`${N} sessions ready`);

  const preMetrics = await fetch(METRICS_URL).then((r) => r.json()) as Record<string, unknown>;
  const preBeam = preMetrics.beam as Record<string, unknown>;
  log(`After start: ${preBeam.process_count} processes, ${((preBeam.total_memory as number) / 1024 / 1024).toFixed(1)}MB`);

  // Send turns to ALL simultaneously
  log("Sending turns to all 10 sessions...");
  const turnPromises = sessionIds.map((tid) =>
    mgr.sendTurn(tid, { input: [{ type: "text", text: "concurrent" }] }).catch(() => {}),
  );
  await Promise.all(turnPromises);
  log("All turns accepted");

  // Poll metrics while running
  const metricSnapshots: Array<Record<string, unknown>> = [];
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const allDone = [...states.values()].every((s) => s.turnsCompleted >= 1);
    if (allDone) break;
    try {
      const m = await fetch(METRICS_URL).then((r) => r.json()) as Record<string, unknown>;
      metricSnapshots.push(m);
    } catch {}
    await sleep(1000);
  }

  const totalDeltas = [...states.values()].reduce((s, st) => s + st.deltas, 0);
  const completed = [...states.values()].filter((s) => s.turnsCompleted >= 1).length;

  let eventsPerSecond = 0;
  if (eventTimestamps.length > 1) {
    const dur = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    eventsPerSecond = dur > 0 ? Math.round(eventTimestamps.length / dur) : 0;
  }

  // Final metrics
  const postMetrics = await fetch(METRICS_URL).then((r) => r.json()) as Record<string, unknown>;
  const postBeam = postMetrics.beam as Record<string, unknown>;
  const postSessions = (postMetrics.sessions as Array<Record<string, unknown>>) ?? [];
  const snapshotServer = postMetrics.snapshot_server as Record<string, unknown>;

  // Per-session stats
  const sessionMemories = postSessions
    .filter((s) => String(s.thread_id ?? "").includes("concurrent-elixir"))
    .map((s) => ({
      memory: s.memory as number,
      gc_count: s.gc_count as number,
      reductions: s.reductions as number,
    }));

  const maxSnapshotQueue = Math.max(
    0,
    ...metricSnapshots.map((m) => ((m.snapshot_server as Record<string, unknown>)?.message_queue_len as number) ?? 0),
  );

  log(`Completed: ${completed}/${N}, total deltas: ${totalDeltas}`);
  log(`Event throughput: ${eventsPerSecond} events/s`);
  log(`SnapshotServer max queue: ${maxSnapshotQueue}`);
  log(`Post: ${postBeam.process_count} processes, ${((postBeam.total_memory as number) / 1024 / 1024).toFixed(1)}MB`);

  if (sessionMemories.length > 0) {
    const avgMem = sessionMemories.reduce((s, m) => s + m.memory, 0) / sessionMemories.length;
    const avgGc = sessionMemories.reduce((s, m) => s + m.gc_count, 0) / sessionMemories.length;
    log(`Per-session avg: mem=${(avgMem / 1024).toFixed(1)}KB, gc=${avgGc.toFixed(0)}`);
  }

  // Cleanup
  try { await mgr.stopAll(); } catch {}
  await sleep(2000);
  mgr.disconnect();

  const completedAt = Date.now();

  const result = {
    test: "concurrent",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metricSnapshots,
    summary: {
      sessionCount: N,
      sessionsCompleted: completed,
      totalDeltas,
      eventsPerSecond,
      snapshotServerMaxQueue: maxSnapshotQueue,
      perSessionMemories: sessionMemories,
      avgSessionMemory: sessionMemories.length > 0 ? Math.round(sessionMemories.reduce((s, m) => s + m.memory, 0) / sessionMemories.length) : 0,
      avgSessionGcCount: sessionMemories.length > 0 ? Math.round(sessionMemories.reduce((s, m) => s + m.gc_count, 0) / sessionMemories.length) : 0,
      beamTotalMemory: postBeam.total_memory,
      beamProcessCount: postBeam.process_count,
      beamGcRuns: postBeam.gc_runs,
    },
  };

  const filename = `elixir-concurrent-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(result, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
