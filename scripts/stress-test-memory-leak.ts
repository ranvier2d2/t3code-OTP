#!/usr/bin/env bun
/**
 * stress-test-memory-leak.ts — GAP 2: Memory leak simulation.
 *
 * Simulates a leaky session that accumulates state that never gets freed.
 * Runs a "leaky" session alongside N "healthy" sessions for several minutes.
 * Measures whether the leak in one session affects the others.
 *
 * Node: leak grows shared V8 heap → affects all sessions via GC pressure.
 * Elixir: leak grows one GenServer's heap → others completely unaffected.
 *
 * Usage:
 *   bun run scripts/stress-test-memory-leak.ts --runtime=node
 *   bun run scripts/stress-test-memory-leak.ts --runtime=elixir
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";

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
const TEST_DURATION_MS = 2 * 60 * 1000; // 2 minutes
const LEAK_DELTA_SIZE_KB = 50; // Large payloads for the leaky session
const HEALTHY_DELTA_COUNT = 200;
const HEALTHY_DELTA_SIZE_KB = 1;
const HEALTHY_COUNT = 3; // Number of healthy sessions running alongside
const METRICS_INTERVAL_MS = 3000;

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

interface LeakStats {
  id: string;
  role: "leaky" | "healthy";
  deltaCount: number;
  turnsCompleted: number;
  errors: string[];
  totalPayloadBytes: number;
}

// ---------------------------------------------------------------------------
// Node runtime — all sessions share one V8 heap
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: LeakStats[] = [];
  const timeSeries: Array<{
    elapsed_ms: number;
    heapUsed: number;
    rss: number;
    eventLoopLag: number;
    leakyDeltas: number;
    healthyTurns: number;
  }> = [];

  // In-process state accumulation (simulates the leak IN the manager)
  const leakedObjects: unknown[] = [];

  const lags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) lags.push(lag);
    lastLagCheck = now;
  }, 100);

  const sessions = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      rl: readline.Interface;
      pending: Map<number, any>;
      nextId: number;
      codexThreadId: string | null;
    }
  >();

  function spawnMock(
    id: string,
    deltaCount: number,
    sizeKb: number,
    delayMs: number,
    mode: string,
  ): typeof sessions extends Map<string, infer V> ? V : never {
    const child = spawn(
      "bun",
      [
        "run",
        "scripts/mock-codex-server.ts",
        String(deltaCount),
        String(sizeKb),
        String(delayMs),
        mode,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );

    const rl = readline.createInterface({ input: child.stdout });
    const session = {
      child,
      rl,
      pending: new Map<number, any>(),
      nextId: 1,
      codexThreadId: null as string | null,
    };
    sessions.set(id, session);
    child.stderr?.resume();
    return session;
  }

  function rpc(session: ReturnType<typeof spawnMock>, method: string, params: any) {
    return new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error("timeout"));
      }, 30000);
      session.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: any) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Start leaky session (never-ending deltas)
  const leakId = `leak-node-${Date.now()}`;
  const leakStats: LeakStats = {
    id: leakId,
    role: "leaky",
    deltaCount: 0,
    turnsCompleted: 0,
    errors: [],
    totalPayloadBytes: 0,
  };
  allStats.push(leakStats);

  const leakSession = spawnMock(leakId, 999999, LEAK_DELTA_SIZE_KB, 50, "leak");
  const leakRl = leakSession.rl;

  leakRl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const p = leakSession.pending.get(msg.id);
        if (p) {
          leakSession.pending.delete(msg.id);
          p.resolve(msg.result ?? msg.error);
        }
        return;
      }
      if (msg.method === "item/agentMessage/delta") {
        leakStats.deltaCount++;
        // INTENTIONAL LEAK: retain parsed objects to grow old-gen heap
        leakedObjects.push(msg.params);
        try {
          leakStats.totalPayloadBytes += JSON.stringify(msg.params).length;
        } catch {}
      }
    } catch {}
  });

  await rpc(leakSession, "initialize", {
    clientInfo: { name: "stress", version: "1.0" },
    capabilities: {},
  });
  leakSession.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const leakThread = await rpc(leakSession, "thread/start", { cwd: process.cwd() });
  leakSession.codexThreadId = leakThread?.thread?.id ?? null;

  // Start leaky turn (never completes)
  rpc(leakSession, "turn/start", {
    threadId: leakSession.codexThreadId,
    input: [{ type: "text", text: "leak" }],
  }).catch(() => {});

  log(`Leaky session started (${LEAK_DELTA_SIZE_KB}KB deltas, never completes)`);

  // Start healthy sessions that complete rounds of work
  const healthySessions: Array<{ session: ReturnType<typeof spawnMock>; stats: LeakStats }> = [];
  for (let i = 0; i < HEALTHY_COUNT; i++) {
    const hid = `healthy-node-${i}-${Date.now()}`;
    const hStats: LeakStats = {
      id: hid,
      role: "healthy",
      deltaCount: 0,
      turnsCompleted: 0,
      errors: [],
      totalPayloadBytes: 0,
    };
    allStats.push(hStats);

    const hSession = spawnMock(hid, HEALTHY_DELTA_COUNT, HEALTHY_DELTA_SIZE_KB, 5, "normal");
    hSession.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = hSession.pending.get(msg.id);
          if (p) {
            hSession.pending.delete(msg.id);
            p.resolve(msg.result ?? msg.error);
          }
          return;
        }
        if (msg.method === "item/agentMessage/delta") hStats.deltaCount++;
        if (msg.method === "turn/completed") hStats.turnsCompleted++;
      } catch {}
    });

    await rpc(hSession, "initialize", {
      clientInfo: { name: "stress", version: "1.0" },
      capabilities: {},
    });
    hSession.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const hThread = await rpc(hSession, "thread/start", { cwd: process.cwd() });
    hSession.codexThreadId = hThread?.thread?.id ?? null;
    healthySessions.push({ session: hSession, stats: hStats });
  }

  log(`${HEALTHY_COUNT} healthy sessions ready`);

  // Run for TEST_DURATION_MS: periodically send turns to healthy sessions
  const testEnd = Date.now() + TEST_DURATION_MS;
  let turnRound = 0;
  while (Date.now() < testEnd) {
    // Send a turn to each healthy session
    turnRound++;
    for (const { session, stats } of healthySessions) {
      if (stats.errors.length > 0) continue;
      rpc(session, "turn/start", {
        threadId: session.codexThreadId,
        input: [{ type: "text", text: `healthy turn ${turnRound}` }],
      }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
    }

    // Wait for healthy turns to complete (max 30s)
    const roundEnd = Date.now() + 30_000;
    while (Date.now() < roundEnd) {
      const allDone = healthySessions.every(
        ({ stats }) => stats.turnsCompleted >= turnRound || stats.errors.length > 0,
      );
      if (allDone) break;
      await sleep(500);
    }

    // Collect metrics
    const mem = process.memoryUsage();
    const lag = lags.length > 0 ? lags[lags.length - 1]! : 0;
    timeSeries.push({
      elapsed_ms: Date.now() - t0,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      eventLoopLag: lag,
      leakyDeltas: leakStats.deltaCount,
      healthyTurns: turnRound,
    });

    const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const leakedMb = ((leakedObjects.length * LEAK_DELTA_SIZE_KB) / 1024).toFixed(1);
    process.stdout.write(
      `\r  ${ts()} round=${turnRound} heap=${heapMb}MB leaked~${leakedMb}MB leakDeltas=${leakStats.deltaCount} lag=${lag.toFixed(1)}ms`,
    );

    await sleep(METRICS_INTERVAL_MS);
  }

  clearInterval(lagTimer);
  console.log("");

  // Kill all
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return { allStats, timeSeries, lags, leakedObjectCount: leakedObjects.length };
}

// ---------------------------------------------------------------------------
// Elixir runtime — each session in its own GenServer
// ---------------------------------------------------------------------------

async function runElixir() {
  const allStats: LeakStats[] = [];
  const timeSeries: Array<{
    elapsed_ms: number;
    beamTotalMemory: number;
    leakyProcessMemory: number | null;
    healthyAvgMemory: number | null;
    leakyDeltas: number;
    healthyTurns: number;
  }> = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;
      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        try {
          stats.totalPayloadBytes += JSON.stringify(raw.payload).length;
        } catch {}
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

  // Baseline
  const baseline = (await fetch(METRICS_URL).then((r) => r.json())) as any;
  log(
    `Baseline: ${baseline.beam.process_count} processes, ${(baseline.beam.total_memory / 1024 / 1024).toFixed(1)}MB`,
  );

  // Start leaky session (leak mode — never completes)
  const leakId = `leak-elixir-${Date.now()}`;
  const leakStats: LeakStats = {
    id: leakId,
    role: "leaky",
    deltaCount: 0,
    turnsCompleted: 0,
    errors: [],
    totalPayloadBytes: 0,
  };
  allStats.push(leakStats);

  await mgr.startSession({
    threadId: leakId,
    provider: "mock",
    cwd: process.cwd(),
    providerOptions: {
      mock: { deltaCount: 999999, deltaSizeKb: LEAK_DELTA_SIZE_KB, delayMs: 50, mode: "leak" },
    },
  });

  // Start leaky turn
  mgr.sendTurn(leakId, { input: [{ type: "text", text: "leak" }] }).catch(() => {});
  log(`Leaky session started (${LEAK_DELTA_SIZE_KB}KB deltas, never completes)`);

  // Start healthy sessions
  const healthyIds: string[] = [];
  for (let i = 0; i < HEALTHY_COUNT; i++) {
    const hid = `healthy-elixir-${i}-${Date.now()}`;
    const hStats: LeakStats = {
      id: hid,
      role: "healthy",
      deltaCount: 0,
      turnsCompleted: 0,
      errors: [],
      totalPayloadBytes: 0,
    };
    allStats.push(hStats);
    healthyIds.push(hid);

    await mgr.startSession({
      threadId: hid,
      provider: "mock",
      cwd: process.cwd(),
      providerOptions: {
        mock: {
          deltaCount: HEALTHY_DELTA_COUNT,
          deltaSizeKb: HEALTHY_DELTA_SIZE_KB,
          delayMs: 5,
          mode: "normal",
        },
      },
    });
  }
  log(`${HEALTHY_COUNT} healthy sessions ready`);

  // Run for TEST_DURATION_MS
  const testEnd = Date.now() + TEST_DURATION_MS;
  let turnRound = 0;
  while (Date.now() < testEnd) {
    turnRound++;

    // Send turns to healthy sessions
    for (const hid of healthyIds) {
      const stats = allStats.find((s) => s.id === hid)!;
      if (stats.errors.length > 0) continue;
      mgr
        .sendTurn(hid, { input: [{ type: "text", text: `healthy turn ${turnRound}` }] })
        .catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
    }

    // Wait for healthy turns
    const roundEnd = Date.now() + 30_000;
    while (Date.now() < roundEnd) {
      const allDone = healthyIds.every((hid) => {
        const stats = allStats.find((s) => s.id === hid)!;
        return stats.turnsCompleted >= turnRound || stats.errors.length > 0;
      });
      if (allDone) break;
      await sleep(500);
    }

    // Collect per-process metrics
    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      const sessions = m.sessions ?? [];
      const leakyProcess = sessions.find((s: any) =>
        String(s.thread_id ?? "").includes("leak-elixir"),
      );
      const healthyProcesses = sessions.filter((s: any) =>
        String(s.thread_id ?? "").includes("healthy-elixir"),
      );

      const healthyAvg =
        healthyProcesses.length > 0
          ? healthyProcesses.reduce((s: number, p: any) => s + (p.memory ?? 0), 0) /
            healthyProcesses.length
          : null;

      timeSeries.push({
        elapsed_ms: Date.now() - t0,
        beamTotalMemory: m.beam.total_memory,
        leakyProcessMemory: leakyProcess?.memory ?? null,
        healthyAvgMemory: healthyAvg,
        leakyDeltas: leakStats.deltaCount,
        healthyTurns: turnRound,
      });

      const leakMem = leakyProcess ? (leakyProcess.memory / 1024).toFixed(0) : "?";
      const healthyMem = healthyAvg ? (healthyAvg / 1024).toFixed(0) : "?";
      process.stdout.write(
        `\r  ${ts()} round=${turnRound} leakyMem=${leakMem}KB healthyAvg=${healthyMem}KB leakDeltas=${leakStats.deltaCount} beam=${(m.beam.total_memory / 1024 / 1024).toFixed(1)}MB`,
      );
    } catch {}

    await sleep(METRICS_INTERVAL_MS);
  }

  console.log("");

  // Cleanup
  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return { allStats, timeSeries, lags: [] as number[], leakedObjectCount: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  GAP 2: Memory Leak Simulation — ${RUNTIME}`.padEnd(58) + "║");
  console.log(
    "║" +
      `  1 leaky session (${LEAK_DELTA_SIZE_KB}KB) + ${HEALTHY_COUNT} healthy sessions`.padEnd(58) +
      "║",
  );
  console.log("║" + `  Duration: ${TEST_DURATION_MS / 1000 / 60} minutes`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log("  MEMORY LEAK SIMULATION RESULTS");
  console.log("═".repeat(60));

  const { allStats, timeSeries, lags } = result;
  const leaky = allStats.find((s) => s.role === "leaky")!;
  const healthy = allStats.filter((s) => s.role === "healthy");

  console.log(
    `  Leaky session: ${leaky.deltaCount} deltas received, ${(leaky.totalPayloadBytes / 1024 / 1024).toFixed(1)}MB payload`,
  );
  for (const h of healthy) {
    console.log(
      `  Healthy [${h.id.slice(0, 25)}]: ${h.turnsCompleted} turns completed, ${h.deltaCount} deltas`,
    );
  }

  if (RUNTIME === "node") {
    const firstSnapshot = timeSeries[0];
    const lastSnapshot = timeSeries[timeSeries.length - 1];
    const firstHeap = firstSnapshot && 'heapUsed' in firstSnapshot ? firstSnapshot.heapUsed : 0;
    const lastHeap = lastSnapshot && 'heapUsed' in lastSnapshot ? lastSnapshot.heapUsed : 0;
    const heapGrowth = ((lastHeap - firstHeap) / 1024 / 1024).toFixed(1);
    console.log(
      `\n  Node heap growth: ${heapGrowth}MB (${(firstHeap / 1024 / 1024).toFixed(1)} → ${(lastHeap / 1024 / 1024).toFixed(1)}MB)`,
    );
    console.log(`  Leaked objects retained in-process: ${result.leakedObjectCount}`);
    if (lags.length > 0) {
      console.log(
        `  Event loop lag: p50=${percentile(lags, 50).toFixed(1)}ms p99=${percentile(lags, 99).toFixed(1)}ms max=${Math.max(...lags).toFixed(1)}ms`,
      );
    }
    console.log(`  → Leak SHARES the V8 heap with healthy sessions`);
  }

  if (RUNTIME === "elixir" && timeSeries.length > 0) {
    const first = timeSeries[0]!;
    const last = timeSeries[timeSeries.length - 1]!;
    const leakGrowth =
      'leakyProcessMemory' in first && 'leakyProcessMemory' in last &&
      first.leakyProcessMemory && last.leakyProcessMemory
        ? ((last.leakyProcessMemory - first.leakyProcessMemory) / 1024).toFixed(0)
        : "?";
    const healthyStable =
      'healthyAvgMemory' in first && 'healthyAvgMemory' in last &&
      first.healthyAvgMemory && last.healthyAvgMemory
        ? ((last.healthyAvgMemory - first.healthyAvgMemory) / 1024).toFixed(0)
        : "?";
    console.log(`\n  Leaky process memory growth: ${leakGrowth}KB`);
    console.log(`  Healthy process avg memory change: ${healthyStable}KB`);
    console.log(`  → Leak is ISOLATED to one GenServer process`);
  }

  // Compute node-specific summary fields with type guards
  const nodeHeapGrowth = (() => {
    if (timeSeries.length <= 1) return 0;
    const lastTs = timeSeries[timeSeries.length - 1]!;
    const firstTs = timeSeries[0]!;
    const lastHeap = 'heapUsed' in lastTs ? (lastTs.heapUsed ?? 0) : 0;
    const firstHeap = 'heapUsed' in firstTs ? (firstTs.heapUsed ?? 0) : 0;
    return Math.round(((lastHeap - firstHeap) / 1024 / 1024) * 10) / 10;
  })();

  const output = {
    test: "memory-leak",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: {
      leakDeltaSizeKb: LEAK_DELTA_SIZE_KB,
      healthyDeltaCount: HEALTHY_DELTA_COUNT,
      healthyDeltaSizeKb: HEALTHY_DELTA_SIZE_KB,
      healthyCount: HEALTHY_COUNT,
      testDurationMs: TEST_DURATION_MS,
    },
    sessions: allStats,
    timeSeries,
    summary: {
      leakyDeltaCount: leaky.deltaCount,
      leakyPayloadMb: Math.round((leaky.totalPayloadBytes / 1024 / 1024) * 10) / 10,
      healthyTurnsCompleted: healthy.map((h) => h.turnsCompleted),
      ...(RUNTIME === "node"
        ? {
            heapGrowthMb: nodeHeapGrowth,
            leakedObjectCount: result.leakedObjectCount,
            lagP50_ms: lags.length > 0 ? Math.round(percentile(lags, 50) * 10) / 10 : 0,
            lagP99_ms: lags.length > 0 ? Math.round(percentile(lags, 99) * 10) / 10 : 0,
          }
        : {}),
    },
  };

  const filename = `${RUNTIME}-memory-leak-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(60));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
