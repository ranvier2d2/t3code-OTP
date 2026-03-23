#!/usr/bin/env bun
/**
 * stress-test-runner.ts — Stress test orchestrator for Elixir harness.
 *
 * Runs Tests A-D against the Elixir harness, collecting metrics at 1-second
 * intervals. Writes JSON results to output/stress-test/.
 *
 * Usage:
 *   bun run scripts/stress-test-runner.ts [--test a|b|c|d|all]
 *
 * Prerequisites:
 *   - Elixir harness running on port 4321 (./scripts/dev-harness.sh)
 *   - Providers available: codex, claudeAgent, cursor, opencode
 */

import { HarnessClientManager, type HarnessRawEvent } from "../apps/server/src/provider/Layers/HarnessClientManager.ts";
import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const METRICS_URL = `http://127.0.0.1:${PORT}/api/metrics`;
const CWD = process.cwd();

const testArg = process.argv.find((a) => a.startsWith("--test="))?.split("=")[1] || "all";

mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricsSample {
  timestamp: number;
  elapsed_ms: number;
  beam: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  snapshot_server: Record<string, unknown>;
}

interface SessionState {
  threadId: string;
  provider: string;
  turnsCompleted: number;
  deltasReceived: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  turnStartedAt: number | null;
  turnCompletedAt: number | null;
  latencies: number[]; // ms from turn/started to first delta
  errors: string[];
  killed: boolean;
  text: string;
}

interface TestResult {
  test: string;
  runtime: "elixir";
  startedAt: number;
  completedAt: number;
  duration_ms: number;
  metrics: MetricsSample[];
  sessions: Record<string, SessionState>;
  summary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

async function fetchMetrics(): Promise<MetricsSample> {
  const res = await fetch(METRICS_URL);
  if (!res.ok) {
    throw new Error(`Metrics fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    timestamp: Date.now(),
    elapsed_ms: Date.now() - t0,
    beam: (data.beam as Record<string, unknown>) ?? {},
    sessions: (data.sessions as Array<Record<string, unknown>>) ?? [],
    snapshot_server: (data.snapshot_server as Record<string, unknown>) ?? {},
  };
}

function writeResult(test: string, result: TestResult) {
  const filename = `elixir-${test}-${Date.now()}.json`;
  const path = `${OUTPUT_DIR}/${filename}`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  log(`Results written to ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function createSessionState(threadId: string, provider: string): SessionState {
  return {
    threadId,
    provider,
    turnsCompleted: 0,
    deltasReceived: 0,
    firstDeltaAt: null,
    lastDeltaAt: null,
    turnStartedAt: null,
    turnCompletedAt: null,
    latencies: [],
    errors: [],
    killed: false,
    text: "",
  };
}

function createManager(sessions: Map<string, SessionState>): HarnessClientManager {
  return new HarnessClientManager({
    harnessPort: PORT,
    harnessSecret: SECRET,
    onEvent: (raw: HarnessRawEvent) => {
      const s = sessions.get(raw.threadId);
      if (!s) return;

      const p = raw.payload as Record<string, unknown> | undefined;

      if (raw.method === "turn/started") {
        s.turnStartedAt = Date.now();
      }

      if (raw.method === "content/delta" || raw.method === "item/agentMessage/delta") {
        const now = Date.now();
        s.deltasReceived++;
        s.lastDeltaAt = now;
        if (s.firstDeltaAt === null) {
          s.firstDeltaAt = now;
          if (s.turnStartedAt) {
            s.latencies.push(now - s.turnStartedAt);
          }
        }
        const delta = String(p?.delta ?? p?.text ?? "");
        s.text += delta;
      }

      if (raw.method === "turn/completed") {
        s.turnsCompleted++;
        s.turnCompletedAt = Date.now();
        // Reset for next turn
        s.firstDeltaAt = null;
        s.turnStartedAt = null;
      }

      if (raw.method === "session/error") {
        s.errors.push(String(p?.message ?? p?.error ?? "unknown error"));
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });
}

/** Collect metrics at 1-second intervals for the given duration */
async function collectMetricsDuring(durationMs: number): Promise<MetricsSample[]> {
  const samples: MetricsSample[] = [];
  const end = Date.now() + durationMs;

  while (Date.now() < end) {
    try {
      samples.push(await fetchMetrics());
    } catch (e) {
      // metrics endpoint may be briefly unavailable
    }
    await sleep(1000);
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Test A: Session Scaling (memory growth)
// ---------------------------------------------------------------------------

async function testA(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST A: Session Scaling (memory growth)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const sessions = new Map<string, SessionState>();
  const mgr = createManager(sessions);
  const allMetrics: MetricsSample[] = [];

  const providers = ["codex", "claudeAgent", "cursor", "opencode"];
  const sessionsPerProvider = 5;
  const prompt = "Count from 1 to 50, one number per line. Do not use any tools.";

  await mgr.connect();
  log("Connected to harness");

  // Baseline metrics
  allMetrics.push(await fetchMetrics());
  log(`Baseline: ${JSON.stringify(allMetrics[0]!.beam).slice(0, 100)}...`);

  // Phase 1: Start sessions in batches by provider
  for (const provider of providers) {
    log(`Starting ${sessionsPerProvider} ${provider} sessions...`);

    for (let i = 0; i < sessionsPerProvider; i++) {
      const threadId = `scaling-${provider}-${i}-${Date.now()}`;
      sessions.set(threadId, createSessionState(threadId, provider));

      try {
        await mgr.startSession({
          threadId,
          provider,
          cwd: CWD,
          runtimeMode: "full-access",
        });
        log(`  ${provider}[${i}] started`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ${provider}[${i}] FAILED: ${msg}`);
        sessions.get(threadId)!.errors.push(msg);
      }
    }

    // Metrics after each provider batch
    allMetrics.push(await fetchMetrics());
  }

  const afterStart = await fetchMetrics();
  allMetrics.push(afterStart);
  log(`After starting ${sessions.size} sessions: process_count=${afterStart.beam.process_count}`);

  // Phase 2: Send 3 turns to each session (in batches to avoid overwhelming)
  for (let turn = 0; turn < 3; turn++) {
    log(`\nTurn ${turn + 1}/3...`);

    const turnPromises: Promise<void>[] = [];
    for (const [threadId, s] of sessions) {
      if (s.errors.length > 0) continue;

      turnPromises.push(
        (async () => {
          try {
            await mgr.sendTurn(threadId, {
              input: [{ type: "text", text: `${prompt} (Turn ${turn + 1})` }],
            });
          } catch (e) {
            s.errors.push(e instanceof Error ? e.message : String(e));
          }
        })(),
      );
    }

    await Promise.all(turnPromises);

    // Wait for turns to complete (max 120s)
    const turnEnd = Date.now() + 120_000;
    while (Date.now() < turnEnd) {
      const allDone = [...sessions.values()]
        .filter((s) => s.errors.length === 0)
        .every((s) => s.turnsCompleted >= turn + 1);
      if (allDone) break;
      allMetrics.push(await fetchMetrics());
      await sleep(2000);
    }

    allMetrics.push(await fetchMetrics());
    const completed = [...sessions.values()].filter((s) => s.turnsCompleted >= turn + 1).length;
    log(`Turn ${turn + 1} complete: ${completed}/${sessions.size} sessions`);
  }

  // Phase 3: Memory after all turns
  const afterTurns = await fetchMetrics();
  allMetrics.push(afterTurns);

  // Phase 4: Kill all sessions and measure cleanup
  log("\nStopping all sessions...");
  try {
    await mgr.stopAll();
  } catch {}

  await sleep(5000); // Give BEAM time to reclaim
  const afterCleanup = await fetchMetrics();
  allMetrics.push(afterCleanup);

  mgr.disconnect();

  const completedAt = Date.now();

  const result: TestResult = {
    test: "scaling",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(sessions),
    summary: {
      totalSessions: sessions.size,
      successfulSessions: [...sessions.values()].filter((s) => s.errors.length === 0).length,
      baselineMemory: allMetrics[0]?.beam.total_memory,
      peakMemory: afterTurns.beam.total_memory,
      afterCleanupMemory: afterCleanup.beam.total_memory,
      memoryReclaimed:
        (afterTurns.beam.total_memory as number) - (afterCleanup.beam.total_memory as number),
      perSessionMemory: afterTurns.sessions.map((s) => ({
        thread_id: s.thread_id,
        provider: s.provider,
        memory: s.memory,
        heap_size: s.heap_size,
      })),
      avgLatency_ms:
        [...sessions.values()]
          .flatMap((s) => s.latencies)
          .reduce((a, b) => a + b, 0) /
          Math.max(1, [...sessions.values()].flatMap((s) => s.latencies).length),
    },
  };

  writeResult("scaling", result);
  log(`Memory reclaimed: ${((result.summary.memoryReclaimed as number) / 1024 / 1024).toFixed(1)}MB`);
  return result;
}

// ---------------------------------------------------------------------------
// Test B: GC Cross-Contamination (isolation)
// ---------------------------------------------------------------------------

async function testB(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST B: GC Cross-Contamination (isolation)");
  console.log("  NOTE: Uses real providers with long/short prompts");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const sessions = new Map<string, SessionState>();
  const allMetrics: MetricsSample[] = [];

  // Session A: heavy workload (Codex — generates lots of text + tool use)
  // Session B: light workload (Codex — simple response, same provider to remove variance)
  const sessionA = { threadId: `gc-heavy-${Date.now()}`, provider: "codex" };
  const sessionB = { threadId: `gc-light-${Date.now()}`, provider: "codex" };

  sessions.set(sessionA.threadId, createSessionState(sessionA.threadId, sessionA.provider));
  sessions.set(sessionB.threadId, createSessionState(sessionB.threadId, sessionB.provider));

  // --- Explicit per-turn latency measurement ---
  // Track timing per turn using a side-channel keyed by threadId
  const turnTimings = new Map<string, { sentAt: number; resolver: ((lat: number) => void) | null }>();

  // Create manager with built-in latency tracking
  const mgr = new HarnessClientManager({
    harnessPort: PORT,
    harnessSecret: SECRET,
    onEvent: (raw: HarnessRawEvent) => {
      // Standard session tracking
      const s = sessions.get(raw.threadId);
      if (!s) return;
      const p = raw.payload as Record<string, unknown> | undefined;

      if (raw.method === "turn/started") {
        s.turnStartedAt = Date.now();
      }
      if (raw.method === "content/delta" || raw.method === "item/agentMessage/delta") {
        const now = Date.now();
        s.deltasReceived++;
        s.lastDeltaAt = now;
        if (s.firstDeltaAt === null) {
          s.firstDeltaAt = now;
          if (s.turnStartedAt) s.latencies.push(now - s.turnStartedAt);
        }
        const delta = String(p?.delta ?? p?.text ?? "");
        s.text += delta;

        // Resolve turn latency measurement
        const timing = turnTimings.get(raw.threadId);
        if (timing?.resolver) {
          const lat = now - timing.sentAt;
          timing.resolver(lat);
          timing.resolver = null;
        }
      }
      if (raw.method === "turn/completed") {
        s.turnsCompleted++;
        s.turnCompletedAt = Date.now();
        s.firstDeltaAt = null;
        s.turnStartedAt = null;
      }
      if (raw.method === "session/error") {
        s.errors.push(String(p?.message ?? p?.error ?? "unknown error"));
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  async function measureTurnLatency(threadId: string, prompt: string, timeoutMs = 60_000): Promise<number> {
    const { promise, resolve } = Promise.withResolvers<number>();
    const timer = setTimeout(() => {
      turnTimings.delete(threadId);
      resolve(-1);
    }, timeoutMs);

    turnTimings.set(threadId, {
      sentAt: Date.now(),
      resolver: (lat) => {
        clearTimeout(timer);
        resolve(lat);
      },
    });

    try {
      await mgr.sendTurn(threadId, {
        input: [{ type: "text", text: prompt }],
      });
    } catch {
      clearTimeout(timer);
      turnTimings.delete(threadId);
      resolve(-1);
    }

    return promise;
  }

  await mgr.connect();
  log("Connected");

  // Phase 1: Baseline — B alone
  log("Phase 1: Baseline — B alone (3 turns)");
  await mgr.startSession({ threadId: sessionB.threadId, provider: sessionB.provider, cwd: CWD, runtimeMode: "full-access" });

  const baselineLatencies: number[] = [];
  for (let i = 0; i < 3; i++) {
    const lat = await measureTurnLatency(sessionB.threadId, "Say hello in exactly one word. Do not use tools.");
    if (lat > 0) baselineLatencies.push(lat);
    log(`  Baseline turn ${i + 1}: ${lat}ms`);

    // Wait for turn completion before sending next
    const sB = sessions.get(sessionB.threadId)!;
    const end = Date.now() + 60_000;
    while (Date.now() < end && sB.turnsCompleted < i + 1) {
      await sleep(500);
    }
    allMetrics.push(await fetchMetrics());
  }

  log(`Baseline latencies: ${baselineLatencies.map((l) => `${l}ms`).join(", ")}`);

  // Phase 2: Start A (heavy) and run B concurrently
  log("\nPhase 2: B with A churning (heavy workload)");
  await mgr.startSession({ threadId: sessionA.threadId, provider: sessionA.provider, cwd: CWD, runtimeMode: "full-access" });

  // Send heavy task to A — await the sendTurn to ensure the turn is accepted,
  // then wait for deltas to confirm Codex is actively streaming.
  const heavyPrompt =
    "Write a very long and detailed essay about the history of computing, from Charles Babbage " +
    "through modern AI. Include every decade. Make it at least 1000 words. Do not use any tools.";

  log("Sending heavy turn to A (awaited)...");
  await mgr.sendTurn(sessionA.threadId, {
    input: [{ type: "text", text: heavyPrompt }],
  });
  log("A turn accepted, waiting for A to start streaming...");

  const sA = sessions.get(sessionA.threadId)!;
  const aStart = Date.now();
  while (Date.now() - aStart < 90_000 && sA.deltasReceived === 0) {
    await sleep(1000);
  }
  log(`A has ${sA.deltasReceived} deltas, proceeding with B measurements`);

  // Now measure B's latency while A churns
  const concurrentLatencies: number[] = [];
  const sB = sessions.get(sessionB.threadId)!;
  for (let i = 0; i < 3; i++) {
    const turnsBefore = sB.turnsCompleted;
    const lat = await measureTurnLatency(sessionB.threadId, "Say hello in exactly one word. Do not use tools.");
    if (lat > 0) concurrentLatencies.push(lat);
    log(`  Concurrent turn ${i + 1}: ${lat}ms (A deltas so far: ${sA.deltasReceived})`);

    // Wait for turn completion
    const end = Date.now() + 60_000;
    while (Date.now() < end && sB.turnsCompleted <= turnsBefore) {
      await sleep(500);
    }
    allMetrics.push(await fetchMetrics());
  }

  log(`Concurrent latencies: ${concurrentLatencies.map((l) => `${l}ms`).join(", ")}`);

  // Cleanup
  try { await mgr.stopAll(); } catch {}
  await sleep(3000);
  allMetrics.push(await fetchMetrics());
  mgr.disconnect();

  const completedAt = Date.now();

  const result: TestResult = {
    test: "gc-contamination",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(sessions),
    summary: {
      baselineLatencies_ms: baselineLatencies,
      concurrentLatencies_ms: concurrentLatencies,
      baselineP50_ms: percentile(baselineLatencies, 50),
      baselineP99_ms: percentile(baselineLatencies, 99),
      concurrentP50_ms: percentile(concurrentLatencies, 50),
      concurrentP99_ms: percentile(concurrentLatencies, 99),
      latencyDelta_ms:
        concurrentLatencies.length > 0 && baselineLatencies.length > 0
          ? percentile(concurrentLatencies, 50) - percentile(baselineLatencies, 50)
          : null,
      crossContamination:
        concurrentLatencies.length > 0 && baselineLatencies.length > 0
          ? percentile(concurrentLatencies, 50) > percentile(baselineLatencies, 50) * 1.5
          : null,
      sessionA_deltas: sessions.get(sessionA.threadId)?.deltasReceived ?? 0,
      sessionB_totalDeltas: sessions.get(sessionB.threadId)?.deltasReceived ?? 0,
    },
  };

  writeResult("gc-contamination", result);
  return result;
}

// ---------------------------------------------------------------------------
// Test C: Crash Churn (recovery)
// ---------------------------------------------------------------------------

async function testC(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST C: Crash Churn (recovery under session kills)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const sessions = new Map<string, SessionState>();
  const mgr = createManager(sessions);
  const allMetrics: MetricsSample[] = [];

  // 5 Codex + 5 Claude = 10 sessions
  const codexIds: string[] = [];
  const claudeIds: string[] = [];

  await mgr.connect();
  log("Connected");

  // Start all 10 sessions
  for (let i = 0; i < 5; i++) {
    const codexId = `crash-codex-${i}-${Date.now()}`;
    const claudeId = `crash-claude-${i}-${Date.now()}`;
    codexIds.push(codexId);
    claudeIds.push(claudeId);

    sessions.set(codexId, createSessionState(codexId, "codex"));
    sessions.set(claudeId, createSessionState(claudeId, "claudeAgent"));

    try {
      await mgr.startSession({ threadId: codexId, provider: "codex", cwd: CWD, runtimeMode: "full-access" });
      log(`codex[${i}] started`);
    } catch (e) {
      sessions.get(codexId)!.errors.push(e instanceof Error ? e.message : String(e));
    }

    try {
      await mgr.startSession({ threadId: claudeId, provider: "claudeAgent", cwd: CWD, runtimeMode: "full-access" });
      log(`claude[${i}] started`);
    } catch (e) {
      sessions.get(claudeId)!.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  allMetrics.push(await fetchMetrics());
  log(`${sessions.size} sessions started`);

  // Send a long task to all sessions
  const prompt = "Write a detailed explanation of how compilers work, covering lexing, parsing, AST construction, and code generation. Do not use tools.";

  for (const [threadId, s] of sessions) {
    if (s.errors.length > 0) continue;
    try {
      await mgr.sendTurn(threadId, { input: [{ type: "text", text: prompt }] });
    } catch (e) {
      s.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  log("Tasks sent to all sessions");
  await sleep(5000); // Let them start streaming

  // Kill 3 Codex sessions
  const killTargets = codexIds.slice(0, 3);
  const survivorLatenciesBefore: number[] = [];

  // Measure survivor latencies just before kill
  for (const id of claudeIds) {
    const s = sessions.get(id);
    if (s && s.latencies.length > 0) {
      survivorLatenciesBefore.push(s.latencies[s.latencies.length - 1]!);
    }
  }

  log(`\nKilling ${killTargets.length} Codex sessions...`);
  const preKillMetrics = await fetchMetrics();
  allMetrics.push(preKillMetrics);

  for (const threadId of killTargets) {
    try {
      await mgr.stopSession(threadId);
      sessions.get(threadId)!.killed = true;
      log(`  Killed: ${threadId.slice(0, 30)}`);
    } catch (e) {
      log(`  Kill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Collect metrics during recovery period (15 seconds)
  log("Monitoring survivor health during recovery...");
  const recoveryMetrics = await collectMetricsDuring(15_000);
  allMetrics.push(...recoveryMetrics);

  // Check survivor state
  const survivors = claudeIds.map((id) => sessions.get(id)!);
  const survivorErrors = survivors.flatMap((s) => s.errors);
  const survivorLatenciesAfter = survivors.flatMap((s) => s.latencies);

  // Memory after kills
  const postKillMetrics = await fetchMetrics();
  allMetrics.push(postKillMetrics);

  // Cleanup
  try { await mgr.stopAll(); } catch {}
  await sleep(3000);
  allMetrics.push(await fetchMetrics());
  mgr.disconnect();

  const completedAt = Date.now();

  const result: TestResult = {
    test: "crash-churn",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(sessions),
    summary: {
      totalSessions: 10,
      killed: killTargets.length,
      survivorCount: claudeIds.length,
      survivorErrors: survivorErrors.length,
      survivorErrorMessages: survivorErrors,
      preKillMemory: preKillMetrics.beam.total_memory,
      postKillMemory: postKillMetrics.beam.total_memory,
      memoryReclaimed:
        (preKillMetrics.beam.total_memory as number) - (postKillMetrics.beam.total_memory as number),
      preKillProcessCount: preKillMetrics.beam.process_count,
      postKillProcessCount: postKillMetrics.beam.process_count,
      processesReclaimed:
        (preKillMetrics.beam.process_count as number) - (postKillMetrics.beam.process_count as number),
      snapshotServerQueueMax: Math.max(
        ...recoveryMetrics.map((m) => (m.snapshot_server.message_queue_len as number) ?? 0),
      ),
      cascadingFailures: survivorErrors.length > 0,
    },
  };

  writeResult("crash-churn", result);
  return result;
}

// ---------------------------------------------------------------------------
// Test D: SnapshotServer Bottleneck
// ---------------------------------------------------------------------------

async function testD(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST D: SnapshotServer Bottleneck (Elixir-specific)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const sessions = new Map<string, SessionState>();
  const mgr = createManager(sessions);
  const allMetrics: MetricsSample[] = [];

  // Start 20 sessions across all 4 providers (5 each)
  const providers = ["codex", "claudeAgent", "cursor", "opencode"];

  await mgr.connect();
  log("Connected");

  allMetrics.push(await fetchMetrics());

  for (const provider of providers) {
    for (let i = 0; i < 5; i++) {
      const threadId = `bottleneck-${provider}-${i}-${Date.now()}`;
      sessions.set(threadId, createSessionState(threadId, provider));

      try {
        await mgr.startSession({ threadId, provider, cwd: CWD, runtimeMode: "full-access" });
      } catch (e) {
        sessions.get(threadId)!.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    log(`${provider}: 5 sessions started`);
  }

  allMetrics.push(await fetchMetrics());
  log(`Total: ${sessions.size} sessions`);

  // Send tasks to ALL sessions simultaneously
  const prompt = "Explain the concept of recursion with 3 examples. Do not use tools.";

  log("Sending tasks to all 20 sessions simultaneously...");
  const sendPromises: Promise<void>[] = [];
  for (const [threadId, s] of sessions) {
    if (s.errors.length > 0) continue;
    sendPromises.push(
      mgr.sendTurn(threadId, { input: [{ type: "text", text: prompt }] }).then(() => {}).catch((e) => {
        s.errors.push(e instanceof Error ? e.message : String(e));
      }),
    );
  }
  await Promise.all(sendPromises);
  log("All tasks sent");

  // Monitor SnapshotServer queue depth for 60 seconds
  log("Monitoring SnapshotServer message queue for 60s...");
  let maxQueueLen = 0;
  const queueSamples: Array<{ elapsed_ms: number; queue_len: number; memory: number }> = [];

  const monitorEnd = Date.now() + 60_000;
  while (Date.now() < monitorEnd) {
    try {
      const m = await fetchMetrics();
      allMetrics.push(m);

      const qLen = (m.snapshot_server.message_queue_len as number) ?? 0;
      const mem = (m.snapshot_server.memory as number) ?? 0;
      queueSamples.push({ elapsed_ms: Date.now() - startedAt, queue_len: qLen, memory: mem });

      if (qLen > maxQueueLen) {
        maxQueueLen = qLen;
        log(`  New queue high: ${qLen} (memory: ${(mem / 1024).toFixed(0)}KB)`);
      }
    } catch {}
    await sleep(1000);
  }

  // Check how many sessions completed
  const completed = [...sessions.values()].filter((s) => s.turnsCompleted > 0).length;
  const errored = [...sessions.values()].filter((s) => s.errors.length > 0).length;
  log(`Sessions completed: ${completed}/${sessions.size}, errored: ${errored}`);

  // Cleanup
  try { await mgr.stopAll(); } catch {}
  await sleep(3000);
  allMetrics.push(await fetchMetrics());
  mgr.disconnect();

  const completedAt = Date.now();

  const result: TestResult = {
    test: "snapshot-bottleneck",
    runtime: "elixir",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(sessions),
    summary: {
      totalSessions: sessions.size,
      sessionsCompleted: completed,
      sessionsErrored: errored,
      snapshotServer: {
        maxQueueLen,
        queueSamples,
        isBottleneck: maxQueueLen > 100,
        assessment:
          maxQueueLen > 1000
            ? "SEVERE bottleneck"
            : maxQueueLen > 100
              ? "Moderate bottleneck"
              : maxQueueLen > 10
                ? "Minor pressure"
                : "No bottleneck detected",
      },
    },
  };

  writeResult("snapshot-bottleneck", result);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + "  T3Code Stress Test Runner — Elixir Harness".padEnd(58) + "║");
  console.log("║" + `  Tests: ${testArg}`.padEnd(58) + "║");
  console.log("║" + `  Harness: ws://127.0.0.1:${PORT}`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // Verify harness is reachable
  try {
    const healthRes = await fetch(`http://127.0.0.1:${PORT}/`);
    const healthText = await healthRes.text();
    log(`Harness health: ${healthText.trim()}`);
  } catch (e) {
    console.error(`ERROR: Cannot reach harness at port ${PORT}. Is dev-harness.sh running?`);
    process.exit(1);
  }

  const results: TestResult[] = [];

  if (testArg === "all" || testArg === "a") {
    results.push(await testA());
  }

  if (testArg === "all" || testArg === "b") {
    results.push(await testB());
  }

  if (testArg === "all" || testArg === "c") {
    results.push(await testC());
  }

  if (testArg === "all" || testArg === "d") {
    results.push(await testD());
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  ALL TESTS COMPLETE");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`  ${r.test}: ${(r.duration_ms / 1000).toFixed(1)}s`);
  }
  console.log(`\n  Results: ${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
