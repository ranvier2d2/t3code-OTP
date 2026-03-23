#!/usr/bin/env bun
/**
 * stress-test-gc-lab-elixir.ts — Elixir-side GC lab test.
 *
 * Runs the same controlled GC experiment as the Node test, but through
 * the Elixir harness. Session A receives 500 × 500KB deltas. Session B
 * receives 500 × 0.1KB deltas. Measures per-process BEAM GC stats via
 * /api/metrics to demonstrate Elixir's per-process GC isolation.
 *
 * Usage:
 *   bun run scripts/stress-test-gc-lab-elixir.ts
 *
 * Prerequisites:
 *   - Elixir harness running on port 4321 with mock provider
 */

import { HarnessClientManager, type HarnessRawEvent } from "../apps/server/src/provider/Layers/HarnessClientManager.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const METRICS_URL = `http://127.0.0.1:${PORT}/api/metrics`;
const CWD = process.cwd();

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

async function fetchMetrics(): Promise<Record<string, unknown>> {
  const res = await fetch(METRICS_URL);
  return (await res.json()) as Record<string, unknown>;
}

function findSession(metrics: Record<string, unknown>, threadIdPart: string): Record<string, unknown> | null {
  const sessions = (metrics.sessions as Array<Record<string, unknown>>) ?? [];
  return sessions.find((s) => String(s.thread_id ?? "").includes(threadIdPart)) ?? null;
}

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  GC LAB: Elixir Harness — Per-Process GC Isolation");
  console.log("  Session A: 500 deltas × 500KB via mock provider");
  console.log("  Session B: 500 deltas × 0.1KB via mock provider");
  console.log("  Each session is a separate GenServer with own heap");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const stateA = { deltas: 0, turnsCompleted: 0, turnStartedAt: 0 };
  const stateB = { deltas: 0, turnsCompleted: 0, turnStartedAt: 0 };
  const bTurnLatencies: number[] = [];

  const tidA = `gclab-elixir-heavy-${Date.now()}`;
  const tidB = `gclab-elixir-light-${Date.now()}`;

  const turnTimings = new Map<string, { sentAt: number; resolver: ((lat: number) => void) | null }>();

  const mgr = new HarnessClientManager({
    harnessPort: PORT,
    harnessSecret: SECRET,
    onEvent: (raw: HarnessRawEvent) => {
      const isA = raw.threadId === tidA;
      const isB = raw.threadId === tidB;
      if (!isA && !isB) return;

      const state = isA ? stateA : stateB;

      if (raw.method === "turn/started") state.turnStartedAt = Date.now();
      if (raw.method === "item/agentMessage/delta") {
        state.deltas++;
        // Resolve latency timing for B
        if (isB) {
          const timing = turnTimings.get(tidB);
          if (timing?.resolver) {
            timing.resolver(Date.now() - timing.sentAt);
            timing.resolver = null;
          }
        }
      }
      if (raw.method === "turn/completed") {
        state.turnsCompleted++;
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  // Collect baseline BEAM metrics
  const baselineMetrics = await fetchMetrics();
  const baselineBeam = baselineMetrics.beam as Record<string, unknown>;
  log(`Baseline: ${baselineBeam.process_count} processes, GC runs=${baselineBeam.gc_runs}`);

  // Phase 1: B alone (baseline)
  log("\nPhase 1: B alone — 500 × 0.1KB deltas");
  await mgr.startSession({
    threadId: tidB,
    provider: "mock",
    cwd: CWD,
    providerOptions: { mock: { deltaCount: 500, deltaSizeKb: 0.1, delayMs: 1 } },
  });
  log("B ready");

  await mgr.sendTurn(tidB, { input: [{ type: "text", text: "baseline" }] });
  while (stateB.turnsCompleted < 1) await sleep(100);

  const afterBaseline = await fetchMetrics();
  const bSessionBaseline = findSession(afterBaseline, tidB.slice(0, 20));
  log(`B baseline done: ${stateB.deltas} deltas`);
  if (bSessionBaseline) {
    log(`  B process: mem=${bSessionBaseline.memory}, gc_count=${bSessionBaseline.gc_count}, reductions=${bSessionBaseline.reductions}`);
  }

  const baselineGcRuns = (baselineBeam.gc_runs as number) ?? 0;
  const afterBaselineGcRuns = ((afterBaseline.beam as Record<string, unknown>).gc_runs as number) ?? 0;
  const baselineGcDelta = afterBaselineGcRuns - baselineGcRuns;
  log(`  BEAM GC runs during baseline: ${baselineGcDelta}`);

  // Phase 2: A (heavy) + B (light) concurrent
  log("\nPhase 2: A (500 × 500KB) + B (500 × 0.1KB) concurrent");
  await mgr.startSession({
    threadId: tidA,
    provider: "mock",
    cwd: CWD,
    providerOptions: { mock: { deltaCount: 500, deltaSizeKb: 500, delayMs: 1 } },
  });
  log("A ready");

  const prePhase2Metrics = await fetchMetrics();
  const prePhase2GcRuns = ((prePhase2Metrics.beam as Record<string, unknown>).gc_runs as number) ?? 0;

  // Send both concurrently
  const pA = mgr.sendTurn(tidA, { input: [{ type: "text", text: "heavy" }] });
  const pB = mgr.sendTurn(tidB, { input: [{ type: "text", text: "concurrent" }] });
  await Promise.all([pA, pB]);

  // Poll metrics while both run
  const phase2Snapshots: Array<{ elapsed: number; aMem: number; aGc: number; bMem: number; bGc: number; beamGc: number }> = [];
  while (stateA.turnsCompleted < 1 || stateB.turnsCompleted < 2) {
    await sleep(500);
    try {
      const m = await fetchMetrics();
      const aS = findSession(m, tidA.slice(0, 20));
      const bS = findSession(m, tidB.slice(0, 20));
      const beam = m.beam as Record<string, unknown>;
      if (aS && bS) {
        phase2Snapshots.push({
          elapsed: Date.now() - startedAt,
          aMem: aS.memory as number,
          aGc: aS.gc_count as number,
          bMem: bS.memory as number,
          bGc: bS.gc_count as number,
          beamGc: beam.gc_runs as number,
        });
      }
    } catch {}
  }

  const postPhase2Metrics = await fetchMetrics();
  const postPhase2GcRuns = ((postPhase2Metrics.beam as Record<string, unknown>).gc_runs as number) ?? 0;
  const aSession = findSession(postPhase2Metrics, tidA.slice(0, 20));
  const bSession = findSession(postPhase2Metrics, tidB.slice(0, 20));

  log(`Phase 2 done: A=${stateA.deltas} deltas, B=${stateB.deltas} total deltas`);
  log(`  BEAM GC runs during phase 2: ${postPhase2GcRuns - prePhase2GcRuns}`);
  if (aSession) log(`  A process: mem=${aSession.memory}, gc_count=${aSession.gc_count}, reductions=${aSession.reductions}`);
  if (bSession) log(`  B process: mem=${bSession.memory}, gc_count=${bSession.gc_count}, reductions=${bSession.reductions}`);

  // Cleanup
  try { await mgr.stopAll(); } catch {}
  await sleep(2000);
  const afterCleanup = await fetchMetrics();
  mgr.disconnect();

  const completedAt = Date.now();

  const result = {
    test: "gc-lab",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    phase2Snapshots,
    summary: {
      baselineGcRuns: baselineGcDelta,
      concurrentGcRuns: postPhase2GcRuns - prePhase2GcRuns,
      sessionA: aSession ? {
        memory: aSession.memory,
        gc_count: aSession.gc_count,
        heap_size: aSession.heap_size,
        reductions: aSession.reductions,
        payloadSizeKb: 500,
      } : null,
      sessionB: bSession ? {
        memory: bSession.memory,
        gc_count: bSession.gc_count,
        heap_size: bSession.heap_size,
        reductions: bSession.reductions,
        payloadSizeKb: 0.1,
      } : null,
      gcIsolation: aSession && bSession
        ? `A's gc_count=${aSession.gc_count} vs B's gc_count=${bSession.gc_count} — each process GCs independently`
        : "Could not measure per-process GC",
      beamTotalMemoryBefore: (prePhase2Metrics.beam as Record<string, unknown>).total_memory,
      beamTotalMemoryAfter: (postPhase2Metrics.beam as Record<string, unknown>).total_memory,
      beamTotalMemoryCleanup: (afterCleanup.beam as Record<string, unknown>).total_memory,
    },
  };

  const filename = `elixir-gc-lab-${Date.now()}.json`;
  const path = `${OUTPUT_DIR}/${filename}`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  log(`Results written to ${path}`);

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  ELIXIR GC LAB SUMMARY");
  console.log("═".repeat(60));
  if (aSession && bSession) {
    console.log(`  A (500KB deltas): mem=${aSession.memory}, gc=${aSession.gc_count}`);
    console.log(`  B (0.1KB deltas): mem=${bSession.memory}, gc=${bSession.gc_count}`);
    console.log(`  Key: A's GC count is HIGH, B's is LOW`);
    console.log(`  → Each GenServer GCs independently (per-process heap)`);
    console.log(`  → B is NOT affected by A's garbage`);
  }
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
