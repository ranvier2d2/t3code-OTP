#!/usr/bin/env bun
/**
 * stress-test-real-workload.ts — Real workload stress test.
 *
 * 5 Codex sessions simultaneously building different applications with
 * full tool access (file creation, editing, command execution, tests).
 * Each session runs in its own temp directory for 5+ minutes.
 *
 * Measures: event throughput with real payloads (file diffs, command output),
 * manager heap growth, event loop lag (Node) / per-process GC (Elixir).
 *
 * Usage:
 *   bun run scripts/stress-test-real-workload.ts --runtime=node
 *   bun run scripts/stress-test-real-workload.ts --runtime=elixir
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
// For Elixir mode
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
const TEST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const METRICS_INTERVAL_MS = 5000;

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
// Prompts — each builds a different app
// ---------------------------------------------------------------------------

const WORKLOAD_PROMPTS = [
  {
    name: "todo-api",
    prompt: `Create a complete TypeScript REST API for a todo app in this directory. Use Bun's built-in HTTP server (Bun.serve). Include:
1. A Todo type with id, title, completed, createdAt fields
2. In-memory storage (array)
3. Routes: GET /todos, POST /todos, PUT /todos/:id, DELETE /todos/:id
4. A test file that tests all 4 CRUD operations using fetch
5. Run the tests and make sure they pass
Put all code in this directory. Do not use any external packages.`,
  },
  {
    name: "calculator-cli",
    prompt: `Create a TypeScript CLI calculator in this directory. Include:
1. A Calculator class with add, subtract, multiply, divide, power, sqrt methods
2. Error handling for division by zero and negative sqrt
3. A history feature that tracks all operations
4. A comprehensive test file with at least 15 test cases covering edge cases
5. Run the tests and make sure they pass
Put all code in this directory.`,
  },
  {
    name: "markdown-parser",
    prompt: `Create a TypeScript markdown parser in this directory. Include:
1. Parse headers (h1-h6), bold, italic, links, code blocks, lists
2. Convert markdown to HTML
3. A comprehensive test file testing each element type with edge cases
4. Create a sample.md file with examples of all supported syntax
5. Run the parser on sample.md and output the HTML
6. Run the tests and make sure they pass
Put all code in this directory.`,
  },
  {
    name: "state-machine",
    prompt: `Create a TypeScript state machine library in this directory. Include:
1. A StateMachine class that accepts states, transitions, and actions
2. Support for guard conditions on transitions
3. Support for entry/exit actions on states
4. An example: traffic light state machine (red→green→yellow→red)
5. Another example: door state machine (locked→unlocked→open→closed→locked)
6. Test file with tests for both examples plus edge cases
7. Run the tests and make sure they pass
Put all code in this directory.`,
  },
  {
    name: "event-emitter",
    prompt: `Create a TypeScript typed event emitter library in this directory. Include:
1. A TypedEventEmitter class with full TypeScript generics for event types
2. Methods: on, off, once, emit, listenerCount, removeAllListeners
3. Support for wildcard listeners
4. Support for async event handlers with Promise.all
5. Memory leak detection (warn if >10 listeners on same event)
6. Comprehensive test file with at least 20 test cases
7. Run the tests and make sure they pass
Put all code in this directory.`,
  },
];

// ---------------------------------------------------------------------------
// Session state tracking
// ---------------------------------------------------------------------------

interface SessionStats {
  name: string;
  threadId: string;
  deltasReceived: number;
  toolCalls: number;
  fileChanges: number;
  commandExecs: number;
  turnsCompleted: number;
  errors: string[];
  totalPayloadBytes: number;
  eventCount: number;
  startedAt: number;
  firstEventAt: number | null;
}

function createStats(name: string, threadId: string): SessionStats {
  return {
    name,
    threadId,
    deltasReceived: 0,
    toolCalls: 0,
    fileChanges: 0,
    commandExecs: 0,
    turnsCompleted: 0,
    errors: [],
    totalPayloadBytes: 0,
    eventCount: 0,
    startedAt: Date.now(),
    firstEventAt: null,
  };
}

function trackEvent(stats: SessionStats, method: string, payload: unknown) {
  stats.eventCount++;
  if (stats.firstEventAt === null) stats.firstEventAt = Date.now();

  // Estimate payload size
  try {
    stats.totalPayloadBytes += JSON.stringify(payload).length;
  } catch {}

  if (method === "item/agentMessage/delta" || method === "content/delta") {
    stats.deltasReceived++;
  }
  if (method === "item/started") {
    const p = payload as Record<string, unknown>;
    if (p?.type === "commandExecution" || method.includes("exec")) stats.commandExecs++;
    if (p?.type === "fileChange" || p?.type === "fileRead") stats.fileChanges++;
    stats.toolCalls++;
  }
  if (method.includes("exec_command")) stats.commandExecs++;
  if (method.includes("patch_apply") || method.includes("fileChange")) stats.fileChanges++;
  if (method === "turn/completed") stats.turnsCompleted++;
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

interface TimeSeriesPoint {
  elapsed_ms: number;
  heapUsed?: number;
  rss?: number;
  eventLoopLag?: number;
  totalEvents: number;
  totalPayloadMb: number;
  // Elixir-specific
  beamTotalMemory?: number;
  beamProcessCount?: number;
  beamGcRuns?: number;
  snapshotQueueLen?: number;
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: SessionStats[] = [];
  const timeSeries: TimeSeriesPoint[] = [];
  const activeSessions = new Map<string, { child: ChildProcessWithoutNullStreams; rl: readline.Interface; pending: Map<number, any>; nextId: number; codexThreadId: string | null }>();

  // Event loop lag
  const lags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) lags.push(lag);
    lastLagCheck = now;
  }, 100);

  // Start sessions
  for (let i = 0; i < WORKLOAD_PROMPTS.length; i++) {
    const workload = WORKLOAD_PROMPTS[i]!;
    const tid = `real-${workload.name}-${Date.now()}`;
    const workDir = `/tmp/t3code-stress-${workload.name}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    const child = spawn("codex", ["app-server"], {
      cwd: workDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const session = { child, rl, pending: new Map<number, any>(), nextId: 1, codexThreadId: null as string | null };
    activeSessions.set(tid, session);

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

    // RPC helper
    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 60000);
      session.pending.set(id, { resolve: (v: any) => { clearTimeout(timer); resolve(v); }, reject: (e: any) => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    try {
      await rpc("initialize", { clientInfo: { name: "stress", version: "1.0" }, capabilities: {} });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", { cwd: workDir, approvalPolicy: "never", sandbox: "danger-full-access" });
      session.codexThreadId = threadResult?.thread?.id ?? null;
      log(`[${workload.name}] ready (cwd: ${workDir})`);
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      log(`[${workload.name}] FAILED: ${stats.errors[0]}`);
    }
  }

  log(`${activeSessions.size} sessions ready, sending tasks...`);

  // Send all tasks simultaneously
  for (let i = 0; i < WORKLOAD_PROMPTS.length; i++) {
    const stats = allStats[i]!;
    const session = activeSessions.get(stats.threadId);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error("timeout")); }, 60000);
      session.pending.set(id, { resolve: (v: any) => { clearTimeout(timer); resolve(v); }, reject: (e: any) => { clearTimeout(timer); reject(e); } });
      session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: WORKLOAD_PROMPTS[i]!.prompt }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  log("All tasks sent. Monitoring for 5 minutes...\n");

  // Monitor for TEST_DURATION_MS
  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);

    const mem = process.memoryUsage();
    const totalEvents = allStats.reduce((s, st) => s + st.eventCount, 0);
    const totalPayload = allStats.reduce((s, st) => s + st.totalPayloadBytes, 0);

    timeSeries.push({
      elapsed_ms: Date.now() - t0,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      totalEvents,
      totalPayloadMb: totalPayload / 1024 / 1024,
    });

    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const events = totalEvents;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${ts()} events=${events} completed=${completed}/${allStats.length} heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB payload=${(totalPayload / 1024 / 1024).toFixed(1)}MB`);

    // Early exit if all done
    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) {
      log("\nAll sessions completed early");
      break;
    }
  }

  clearInterval(lagTimer);
  console.log(""); // newline after \r

  // Kill all
  for (const [, session] of activeSessions) {
    try { session.child.kill(); } catch {}
  }

  return { allStats, timeSeries, lags };
}

// ---------------------------------------------------------------------------
// Elixir runtime
// ---------------------------------------------------------------------------

async function runElixir() {
  const allStats: SessionStats[] = [];
  const timeSeries: TimeSeriesPoint[] = [];

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.threadId === raw.threadId);
      if (stats) trackEvent(stats, raw.method, raw.payload);
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  // Start sessions
  for (let i = 0; i < WORKLOAD_PROMPTS.length; i++) {
    const workload = WORKLOAD_PROMPTS[i]!;
    const tid = `real-elixir-${workload.name}-${Date.now()}`;
    const workDir = `/tmp/t3code-stress-${workload.name}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    try {
      await mgr.startSession({ threadId: tid, provider: "codex", cwd: workDir, runtimeMode: "full-access" });
      log(`[${workload.name}] ready (cwd: ${workDir})`);
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      log(`[${workload.name}] FAILED`);
    }
  }

  log(`${allStats.filter((s) => s.errors.length === 0).length} sessions ready, sending tasks...`);

  // Send all tasks
  for (let i = 0; i < WORKLOAD_PROMPTS.length; i++) {
    const stats = allStats[i]!;
    if (stats.errors.length > 0) continue;

    mgr.sendTurn(stats.threadId, {
      input: [{ type: "text", text: WORKLOAD_PROMPTS[i]!.prompt }],
    }).catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  log("All tasks sent. Monitoring for 5 minutes...\n");

  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);

    try {
      const m = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/metrics`).then((r) => r.json()) as any;
      const beam = m.beam;
      const totalEvents = allStats.reduce((s, st) => s + st.eventCount, 0);
      const totalPayload = allStats.reduce((s, st) => s + st.totalPayloadBytes, 0);

      timeSeries.push({
        elapsed_ms: Date.now() - t0,
        beamTotalMemory: beam.total_memory,
        beamProcessCount: beam.process_count,
        beamGcRuns: beam.gc_runs,
        snapshotQueueLen: m.snapshot_server?.message_queue_len ?? 0,
        totalEvents,
        totalPayloadMb: totalPayload / 1024 / 1024,
      });

      const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
      process.stdout.write(`\r  ${ts()} events=${totalEvents} completed=${completed}/${allStats.length} mem=${(beam.total_memory / 1024 / 1024).toFixed(1)}MB payload=${(totalPayload / 1024 / 1024).toFixed(1)}MB procs=${beam.process_count}`);
    } catch {}

    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) {
      log("\nAll sessions completed early");
      break;
    }
  }

  console.log("");
  try { await mgr.stopAll(); } catch {}
  mgr.disconnect();

  return { allStats, timeSeries, lags: [] as number[] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  Real Workload Stress Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  ${WORKLOAD_PROMPTS.length} sessions × real app building × 5 min`.padEnd(58) + "║");
  console.log("║" + "  Full tool access (files, commands, tests)".padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const { allStats, timeSeries, lags } = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("  RESULTS");
  console.log("═".repeat(60));

  for (const stats of allStats) {
    const duration = ((stats.firstEventAt ? Date.now() - stats.firstEventAt : 0) / 1000).toFixed(0);
    console.log(`  [${stats.name}] events=${stats.eventCount} deltas=${stats.deltasReceived} tools=${stats.toolCalls} files=${stats.fileChanges} cmds=${stats.commandExecs} turns=${stats.turnsCompleted} payload=${(stats.totalPayloadBytes / 1024).toFixed(0)}KB dur=${duration}s${stats.errors.length > 0 ? " ERRORS=" + stats.errors.length : ""}`);
  }

  const totalEvents = allStats.reduce((s, st) => s + st.eventCount, 0);
  const totalPayload = allStats.reduce((s, st) => s + st.totalPayloadBytes, 0);
  const totalDuration = (completedAt - startedAt) / 1000;

  console.log(`\n  Total: ${totalEvents} events, ${(totalPayload / 1024 / 1024).toFixed(1)}MB payload, ${totalDuration.toFixed(0)}s`);
  console.log(`  Throughput: ${Math.round(totalEvents / totalDuration)} events/s`);

  if (RUNTIME === "node" && lags.length > 0) {
    console.log(`  Event loop lag: p50=${percentile(lags, 50).toFixed(1)}ms, p99=${percentile(lags, 99).toFixed(1)}ms, max=${Math.max(...lags).toFixed(1)}ms`);
  }

  const result = {
    test: "real-workload",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    sessions: allStats,
    timeSeries,
    summary: {
      sessionCount: allStats.length,
      completed: allStats.filter((s) => s.turnsCompleted > 0).length,
      totalEvents,
      totalPayloadMb: Math.round(totalPayload / 1024 / 1024 * 10) / 10,
      eventsPerSecond: Math.round(totalEvents / totalDuration),
      ...(RUNTIME === "node" && lags.length > 0
        ? {
            lagP50_ms: Math.round(percentile(lags, 50) * 10) / 10,
            lagP99_ms: Math.round(percentile(lags, 99) * 10) / 10,
            lagMax_ms: Math.round(Math.max(...lags) * 10) / 10,
          }
        : {}),
    },
  };

  const filename = `${RUNTIME}-real-workload-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(result, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);

  // Force exit (child processes may linger)
  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
