#!/usr/bin/env bun
/**
 * stress-test-node.ts — Node/V8 baseline stress test.
 *
 * Mimics CodexAppServerManager's architecture: spawns codex app-server
 * child processes, manages them in a single Node process with a shared
 * V8 heap, collects metrics that demonstrate Node's structural limitations.
 *
 * Usage:
 *   bun run scripts/stress-test-node.ts [--test a|b|c|all]
 *
 * Prerequisites:
 *   - `codex` binary available
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import v8 from "node:v8";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const CWD = process.cwd();
const testArg = process.argv.find((a) => a.startsWith("--test="))?.split("=")[1] || "all";

mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NodeMetricsSample {
  timestamp: number;
  elapsed_ms: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    arrayBuffers: number;
  };
  v8Heap: {
    totalHeapSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
  };
  sessionCount: number;
  eventLoopLag_ms: number;
  perSessionMemory: string; // "not available — shared V8 heap"
}

interface SessionState {
  threadId: string;
  provider: string;
  turnsCompleted: number;
  deltasReceived: number;
  firstDeltaAt: number | null;
  turnStartedAt: number | null;
  turnCompletedAt: number | null;
  latencies: number[];
  errors: string[];
  killed: boolean;
  text: string;
}

interface CodexSession {
  threadId: string;
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  codexThreadId: string | null;
  nextRequestId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>;
  ready: boolean;
  onNotification: (method: string, params: Record<string, unknown>) => void;
}

interface TestResult {
  test: string;
  runtime: "node";
  startedAt: number;
  completedAt: number;
  duration_ms: number;
  metrics: NodeMetricsSample[];
  sessions: Record<string, SessionState>;
  summary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setTimeout(() => {
      resolve(Math.max(0, Number(process.hrtime.bigint() - start) / 1e6 - 1));
    }, 1);
  });
}

function collectNodeMetrics(sessionCount: number): NodeMetricsSample {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    timestamp: Date.now(),
    elapsed_ms: Date.now() - t0,
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    v8Heap: {
      totalHeapSize: heap.total_heap_size,
      usedHeapSize: heap.used_heap_size,
      heapSizeLimit: heap.heap_size_limit,
      mallocedMemory: heap.malloced_memory,
    },
    sessionCount,
    eventLoopLag_ms: 0, // filled in async
    perSessionMemory: "not available — shared V8 heap",
  };
}

function writeResult(test: string, result: TestResult) {
  const filename = `node-${test}-${Date.now()}.json`;
  const path = `${OUTPUT_DIR}/${filename}`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  log(`Results written to ${path}`);
}

function createSessionState(threadId: string, provider: string): SessionState {
  return {
    threadId,
    provider,
    turnsCompleted: 0,
    deltasReceived: 0,
    firstDeltaAt: null,
    turnStartedAt: null,
    turnCompletedAt: null,
    latencies: [],
    errors: [],
    killed: false,
    text: "",
  };
}

// ---------------------------------------------------------------------------
// Codex Session Manager (mimics CodexAppServerManager)
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, CodexSession>();

function sendRpc(session: CodexSession, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = session.nextRequestId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const timer = setTimeout(() => {
      if (session.pending.has(id)) {
        session.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${id})`));
      }
    }, 60_000);

    session.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      method,
    });

    session.child.stdin.write(msg + "\n");
  });
}

function sendNotification(session: CodexSession, method: string, params?: Record<string, unknown>): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
  session.child.stdin.write(msg + "\n");
}

async function startCodexSession(
  threadId: string,
  state: SessionState,
  onNotification: (method: string, params: Record<string, unknown>) => void,
): Promise<CodexSession> {
  const codexPath = "codex";
  const child = spawn(codexPath, ["app-server"], {
    cwd: CWD,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: child.stdout });

  const session: CodexSession = {
    threadId,
    child,
    rl,
    codexThreadId: null,
    nextRequestId: 1,
    pending: new Map(),
    ready: false,
    onNotification,
  };

  // Process stdout lines (JSON-RPC messages)
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);

      // Response to a request
      if (msg.id !== undefined && msg.id !== null) {
        const pending = session.pending.get(msg.id);
        if (pending) {
          session.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || "RPC error"));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      // Notification from codex
      if (msg.method) {
        onNotification(msg.method, msg.params ?? {});
      }
    } catch {
      // non-JSON line, ignore
    }
  });

  // Ignore stderr
  child.stderr?.resume();

  // Handle exit
  child.on("exit", (code) => {
    session.ready = false;
    for (const [id, p] of session.pending) {
      p.reject(new Error(`Process exited with code ${code}`));
      session.pending.delete(id);
    }
  });

  activeSessions.set(threadId, session);

  // Initialize handshake (same as CodexAppServerManager)
  await sendRpc(session, "initialize", {
    clientInfo: { name: "t3-stress-test", version: "1.0.0" },
    capabilities: {},
  });
  sendNotification(session, "initialized");

  // Start thread
  const threadResult = await sendRpc(session, "thread/start", {
    cwd: CWD,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  }) as Record<string, unknown>;

  const thread = threadResult.thread as Record<string, unknown> | undefined;
  session.codexThreadId = (thread?.id as string) ?? null;
  session.ready = true;

  return session;
}

async function sendTurn(session: CodexSession, prompt: string): Promise<unknown> {
  const codexTid = session.codexThreadId ?? session.threadId;
  return sendRpc(session, "turn/start", {
    threadId: codexTid,
    input: [{ type: "text", text: prompt }],
  });
}

function killSession(threadId: string): void {
  const session = activeSessions.get(threadId);
  if (session) {
    try { session.child.kill(); } catch {}
    activeSessions.delete(threadId);
  }
}

function killAllSessions(): void {
  for (const [tid] of activeSessions) {
    killSession(tid);
  }
}

// ---------------------------------------------------------------------------
// Test A: Session Scaling (memory growth)
// ---------------------------------------------------------------------------

async function testA(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST A: Session Scaling (Node baseline)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const states = new Map<string, SessionState>();
  const allMetrics: NodeMetricsSample[] = [];
  const sessionsPerBatch = 5;
  const prompt = "Count from 1 to 50, one number per line. Do not use any tools.";

  // Baseline
  allMetrics.push(collectNodeMetrics(0));
  log(`Baseline heap: ${(allMetrics[0]!.memory.heapUsed / 1024 / 1024).toFixed(1)}MB`);

  // Start 5 Codex sessions (Node only supports Codex via app-server)
  const sessionIds: string[] = [];

  for (let i = 0; i < sessionsPerBatch; i++) {
    const threadId = `node-scaling-${i}-${Date.now()}`;
    sessionIds.push(threadId);
    states.set(threadId, createSessionState(threadId, "codex"));

    const state = states.get(threadId)!;

    try {
      await startCodexSession(threadId, state, (method, params) => {
        if (method === "turn/started") state.turnStartedAt = Date.now();
        if (method === "item/agentMessage/delta") {
          const now = Date.now();
          state.deltasReceived++;
          if (state.firstDeltaAt === null) {
            state.firstDeltaAt = now;
            if (state.turnStartedAt) state.latencies.push(now - state.turnStartedAt);
          }
          state.text += String((params as any).delta ?? "");
        }
        if (method === "turn/completed") {
          state.turnsCompleted++;
          state.turnCompletedAt = Date.now();
          state.firstDeltaAt = null;
          state.turnStartedAt = null;
        }
      });
      log(`codex[${i}] started`);
    } catch (e) {
      state.errors.push(e instanceof Error ? e.message : String(e));
      log(`codex[${i}] FAILED: ${state.errors[0]}`);
    }
  }

  allMetrics.push(collectNodeMetrics(activeSessions.size));
  log(`After starting ${activeSessions.size} sessions: heap=${(allMetrics[allMetrics.length - 1]!.memory.heapUsed / 1024 / 1024).toFixed(1)}MB`);

  // Send 3 turns to each
  for (let turn = 0; turn < 3; turn++) {
    log(`\nTurn ${turn + 1}/3...`);

    for (const tid of sessionIds) {
      const state = states.get(tid)!;
      if (state.errors.length > 0) continue;
      const session = activeSessions.get(tid);
      if (!session) continue;

      try {
        await sendTurn(session, `${prompt} (Turn ${turn + 1})`);
      } catch (e) {
        state.errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    // Wait for turns (max 120s)
    const turnEnd = Date.now() + 120_000;
    while (Date.now() < turnEnd) {
      const allDone = [...states.values()]
        .filter((s) => s.errors.length === 0)
        .every((s) => s.turnsCompleted >= turn + 1);
      if (allDone) break;
      allMetrics.push(collectNodeMetrics(activeSessions.size));
      await sleep(2000);
    }

    allMetrics.push(collectNodeMetrics(activeSessions.size));
    const completed = [...states.values()].filter((s) => s.turnsCompleted >= turn + 1).length;
    log(`Turn ${turn + 1} complete: ${completed}/${states.size} sessions`);
  }

  const afterTurns = collectNodeMetrics(activeSessions.size);
  allMetrics.push(afterTurns);

  // Kill all and measure cleanup
  log("\nKilling all sessions...");
  killAllSessions();
  await sleep(5000);
  // Force GC if available
  try { global.gc?.(); } catch {}
  await sleep(2000);
  const afterCleanup = collectNodeMetrics(0);
  allMetrics.push(afterCleanup);

  const completedAt = Date.now();

  const result: TestResult = {
    test: "scaling",
    runtime: "node",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(states),
    summary: {
      totalSessions: states.size,
      successfulSessions: [...states.values()].filter((s) => s.errors.length === 0).length,
      baselineHeap: allMetrics[0]?.memory.heapUsed,
      peakHeap: afterTurns.memory.heapUsed,
      afterCleanupHeap: afterCleanup.memory.heapUsed,
      heapReclaimed: afterTurns.memory.heapUsed - afterCleanup.memory.heapUsed,
      peakRss: Math.max(...allMetrics.map((m) => m.memory.rss)),
      perSessionMemory: "NOT AVAILABLE — shared V8 heap (this is the structural gap)",
      avgLatency_ms:
        [...states.values()]
          .flatMap((s) => s.latencies)
          .reduce((a, b) => a + b, 0) /
          Math.max(1, [...states.values()].flatMap((s) => s.latencies).length),
    },
  };

  writeResult("scaling", result);
  log(`Heap reclaimed: ${((result.summary.heapReclaimed as number) / 1024 / 1024).toFixed(1)}MB`);
  return result;
}

// ---------------------------------------------------------------------------
// Test B: GC Cross-Contamination
// ---------------------------------------------------------------------------

async function testB(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST B: GC Cross-Contamination (Node baseline)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const states = new Map<string, SessionState>();
  const allMetrics: NodeMetricsSample[] = [];

  const tidA = `node-heavy-${Date.now()}`;
  const tidB = `node-light-${Date.now()}`;
  states.set(tidA, createSessionState(tidA, "codex"));
  states.set(tidB, createSessionState(tidB, "codex"));
  const stateA = states.get(tidA)!;
  const stateB = states.get(tidB)!;

  // Latency measurement helper
  const turnTimings = new Map<string, { sentAt: number; resolver: ((lat: number) => void) | null }>();

  const makeHandler = (state: SessionState, tid: string) => (method: string, params: Record<string, unknown>) => {
    if (method === "turn/started") state.turnStartedAt = Date.now();
    if (method === "item/agentMessage/delta") {
      const now = Date.now();
      state.deltasReceived++;
      if (state.firstDeltaAt === null) {
        state.firstDeltaAt = now;
        if (state.turnStartedAt) state.latencies.push(now - state.turnStartedAt);
      }
      state.text += String((params as any).delta ?? "");

      const timing = turnTimings.get(tid);
      if (timing?.resolver) {
        timing.resolver(now - timing.sentAt);
        timing.resolver = null;
      }
    }
    if (method === "turn/completed") {
      state.turnsCompleted++;
      state.turnCompletedAt = Date.now();
      state.firstDeltaAt = null;
      state.turnStartedAt = null;
    }
  };

  async function measureTurnLatency(session: CodexSession, tid: string, prompt: string): Promise<number> {
    return new Promise<number>(async (resolve) => {
      const timer = setTimeout(() => { turnTimings.delete(tid); resolve(-1); }, 60_000);
      turnTimings.set(tid, { sentAt: Date.now(), resolver: (lat) => { clearTimeout(timer); resolve(lat); } });
      try { await sendTurn(session, prompt); } catch { clearTimeout(timer); resolve(-1); }
    });
  }

  // Phase 1: B alone (baseline)
  log("Phase 1: Baseline — B alone (3 turns)");
  const sessionB = await startCodexSession(tidB, stateB, makeHandler(stateB, tidB));
  log("B ready");

  const baselineLatencies: number[] = [];
  for (let i = 0; i < 3; i++) {
    const lat = await measureTurnLatency(sessionB, tidB, "Say hello in exactly one word. Do not use tools.");
    if (lat > 0) baselineLatencies.push(lat);
    log(`  Baseline turn ${i + 1}: ${lat}ms`);
    const end = Date.now() + 60_000;
    while (Date.now() < end && stateB.turnsCompleted < i + 1) await sleep(500);
    allMetrics.push(collectNodeMetrics(activeSessions.size));
  }
  log(`Baseline latencies: ${baselineLatencies.map((l) => `${l}ms`).join(", ")}`);

  // Phase 2: A churning + B concurrent
  log("\nPhase 2: B with A churning");
  const sessionA = await startCodexSession(tidA, stateA, makeHandler(stateA, tidA));
  log("A ready");

  const heavyPrompt =
    "Write a very long and detailed essay about the history of computing, from Charles Babbage " +
    "through modern AI. Include every decade. Make it at least 1000 words. Do not use any tools.";

  log("Sending heavy turn to A (awaited)...");
  await sendTurn(sessionA, heavyPrompt);
  log("A turn accepted, waiting for streaming...");
  const aStart = Date.now();
  while (Date.now() - aStart < 90_000 && stateA.deltasReceived === 0) await sleep(1000);
  log(`A has ${stateA.deltasReceived} deltas, proceeding`);

  const concurrentLatencies: number[] = [];
  for (let i = 0; i < 3; i++) {
    const turnsBefore = stateB.turnsCompleted;
    const lat = await measureTurnLatency(sessionB, tidB, "Say hello in exactly one word. Do not use tools.");
    if (lat > 0) concurrentLatencies.push(lat);
    log(`  Concurrent turn ${i + 1}: ${lat}ms (A deltas: ${stateA.deltasReceived})`);
    const end = Date.now() + 60_000;
    while (Date.now() < end && stateB.turnsCompleted <= turnsBefore) await sleep(500);
    allMetrics.push(collectNodeMetrics(activeSessions.size));
  }
  log(`Concurrent latencies: ${concurrentLatencies.map((l) => `${l}ms`).join(", ")}`);

  killAllSessions();
  await sleep(3000);
  allMetrics.push(collectNodeMetrics(0));

  const completedAt = Date.now();
  const result: TestResult = {
    test: "gc-contamination",
    runtime: "node",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(states),
    summary: {
      baselineLatencies_ms: baselineLatencies,
      concurrentLatencies_ms: concurrentLatencies,
      baselineP50_ms: percentile(baselineLatencies, 50),
      concurrentP50_ms: percentile(concurrentLatencies, 50),
      latencyDelta_ms:
        concurrentLatencies.length > 0 && baselineLatencies.length > 0
          ? percentile(concurrentLatencies, 50) - percentile(baselineLatencies, 50)
          : null,
      sessionA_deltas: stateA.deltasReceived,
      sessionB_totalDeltas: stateB.deltasReceived,
      note: "Node's V8 GC is stop-the-world — all sessions share the same heap. " +
            "Cross-contamination may not show in this test because child processes " +
            "run in separate OS processes, but GC in the MANAGER process affects all event handling.",
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
  console.log("  TEST C: Crash Churn (Node baseline)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const states = new Map<string, SessionState>();
  const allMetrics: NodeMetricsSample[] = [];
  const sessionIds: string[] = [];

  // Start 10 sessions
  for (let i = 0; i < 10; i++) {
    const tid = `node-crash-${i}-${Date.now()}`;
    sessionIds.push(tid);
    const state = createSessionState(tid, "codex");
    states.set(tid, state);

    try {
      await startCodexSession(tid, state, (method, params) => {
        if (method === "turn/started") state.turnStartedAt = Date.now();
        if (method === "item/agentMessage/delta") {
          state.deltasReceived++;
          if (state.firstDeltaAt === null) state.firstDeltaAt = Date.now();
          state.text += String((params as any).delta ?? "");
        }
        if (method === "turn/completed") {
          state.turnsCompleted++;
          state.turnCompletedAt = Date.now();
          state.firstDeltaAt = null;
          state.turnStartedAt = null;
        }
      });
      log(`session[${i}] started`);
    } catch (e) {
      state.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  allMetrics.push(collectNodeMetrics(activeSessions.size));
  log(`${activeSessions.size} sessions started`);

  // Send tasks
  const prompt = "Write a detailed explanation of how compilers work, covering lexing, parsing, AST construction, and code generation. Do not use tools.";
  for (const tid of sessionIds) {
    const state = states.get(tid)!;
    if (state.errors.length > 0) continue;
    const session = activeSessions.get(tid);
    if (session) {
      try { await sendTurn(session, prompt); } catch (e) {
        state.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  log("Tasks sent, waiting 5s before kills...");
  await sleep(5000);

  const preKill = collectNodeMetrics(activeSessions.size);
  allMetrics.push(preKill);

  // Kill first 3
  const killTargets = sessionIds.slice(0, 3);
  log(`Killing ${killTargets.length} sessions...`);
  for (const tid of killTargets) {
    killSession(tid);
    states.get(tid)!.killed = true;
    log(`  Killed: ${tid.slice(0, 30)}`);
  }

  // Monitor survivors for 15s
  log("Monitoring survivors...");
  for (let i = 0; i < 15; i++) {
    allMetrics.push(collectNodeMetrics(activeSessions.size));
    await sleep(1000);
  }

  // Check survivor state
  const survivorIds = sessionIds.slice(3);
  const survivorErrors = survivorIds
    .map((tid) => states.get(tid)!)
    .flatMap((s) => s.errors);

  const postKill = collectNodeMetrics(activeSessions.size);
  allMetrics.push(postKill);

  killAllSessions();
  await sleep(3000);
  try { global.gc?.(); } catch {}
  await sleep(2000);
  allMetrics.push(collectNodeMetrics(0));

  const completedAt = Date.now();

  const result: TestResult = {
    test: "crash-churn",
    runtime: "node",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(states),
    summary: {
      totalSessions: 10,
      killed: killTargets.length,
      survivorCount: survivorIds.length,
      survivorErrors: survivorErrors.length,
      survivorErrorMessages: survivorErrors,
      preKillHeap: preKill.memory.heapUsed,
      postKillHeap: postKill.memory.heapUsed,
      heapReclaimed: preKill.memory.heapUsed - postKill.memory.heapUsed,
      preKillRss: preKill.memory.rss,
      postKillRss: postKill.memory.rss,
      cascadingFailures: survivorErrors.length > 0,
      note: "Node kills child processes via child.kill(). The V8 heap shared by " +
            "the manager process is NOT immediately affected — GC reclaims eventually.",
    },
  };

  writeResult("crash-churn", result);
  return result;
}

// ---------------------------------------------------------------------------
// Test GC-Lab: Controlled GC cross-contamination with mock server
// ---------------------------------------------------------------------------

/** Spawn a mock Codex server with configurable payload sizes */
function startMockSession(
  threadId: string,
  state: SessionState,
  deltaCount: number,
  deltaSizeKb: number,
  delayMs: number,
  onNotification: (method: string, params: Record<string, unknown>) => void,
): Promise<CodexSession> {
  return new Promise((resolve, reject) => {
    const mockPath = `${process.cwd()}/scripts/mock-codex-server.ts`;
    const child = spawn("bun", ["run", mockPath, String(deltaCount), String(deltaSizeKb), String(delayMs)], {
      cwd: CWD,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const session: CodexSession = {
      threadId,
      child,
      rl,
      codexThreadId: null,
      nextRequestId: 1,
      pending: new Map(),
      ready: false,
      onNotification,
    };

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) {
          const pending = session.pending.get(msg.id);
          if (pending) {
            session.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message || "RPC error"));
            else pending.resolve(msg.result);
          }
          return;
        }
        if (msg.method) onNotification(msg.method, msg.params ?? {});
      } catch {}
    });

    child.stderr?.resume();
    child.on("exit", () => {
      for (const [id, p] of session.pending) {
        p.reject(new Error("Process exited"));
        session.pending.delete(id);
      }
    });

    activeSessions.set(threadId, session);

    // Initialize handshake
    sendRpc(session, "initialize", { clientInfo: { name: "gc-lab", version: "1.0" }, capabilities: {} })
      .then(() => {
        sendNotification(session, "initialized");
        return sendRpc(session, "thread/start", {});
      })
      .then((result: any) => {
        session.codexThreadId = result?.thread?.id ?? null;
        session.ready = true;
        resolve(session);
      })
      .catch(reject);
  });
}

async function testGcLab(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST GC-LAB: Controlled GC Cross-Contamination");
  console.log("  Session A: 500 deltas × 500KB (creates ~250MB garbage)");
  console.log("  Session B: 500 deltas × 0.1KB (tiny payloads)");
  console.log("  Both in same Node process (shared V8 heap)");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const states = new Map<string, SessionState>();
  const allMetrics: NodeMetricsSample[] = [];
  const gcPauses: Array<{ time: number; duration: number; kind: string }> = [];

  // Set up GC observer if available (Node, not guaranteed in Bun)
  let gcObserver: any = null;
  try {
    const { PerformanceObserver } = await import("node:perf_hooks");
    gcObserver = new PerformanceObserver((list: any) => {
      for (const entry of list.getEntries()) {
        gcPauses.push({
          time: entry.startTime,
          duration: entry.duration,
          kind: entry.detail?.kind === 1 ? "scavenge" : entry.detail?.kind === 2 ? "mark-sweep" : `kind-${entry.detail?.kind ?? "?"}`,
        });
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    log("GC observer active");
  } catch {
    log("GC observer not available (Bun) — using event loop lag instead");
  }

  const tidA = `gclab-heavy-${Date.now()}`;
  const tidB = `gclab-light-${Date.now()}`;
  states.set(tidA, createSessionState(tidA, "mock-codex"));
  states.set(tidB, createSessionState(tidB, "mock-codex"));
  const stateA = states.get(tidA)!;
  const stateB = states.get(tidB)!;

  // Accumulate parsed objects to force old-gen promotion (prevents young-gen fast path)
  // This simulates a real session manager that retains event state (like SnapshotServer)
  const retainedObjects: unknown[] = [];

  // Event loop lag: measures how long the event loop is blocked (captures GC pauses)
  const bEventLoopLags: number[] = [];
  let lagTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLagCheck = performance.now();

  function startLagMonitor() {
    function check() {
      const now = performance.now();
      const lag = now - lastLagCheck - 1; // Expected ~1ms
      if (lag > 0.5) bEventLoopLags.push(lag);
      lastLagCheck = now;
      lagTimer = setTimeout(check, 1);
    }
    lastLagCheck = performance.now();
    lagTimer = setTimeout(check, 1);
  }
  function stopLagMonitor() {
    if (lagTimer) clearTimeout(lagTimer);
  }

  const makeLabHandler = (state: SessionState, retainDeltas: boolean) =>
    (method: string, params: Record<string, unknown>) => {
      if (method === "turn/started") state.turnStartedAt = Date.now();
      if (method === "item/agentMessage/delta") {
        state.deltasReceived++;
        if (state.firstDeltaAt === null) state.firstDeltaAt = Date.now();
        const delta = String((params as any).delta ?? "");
        state.text += delta.slice(0, 100);

        if (retainDeltas) {
          // KEEP the parsed object alive → forces old-gen promotion → triggers mark-sweep
          retainedObjects.push({ delta, params, ts: Date.now() });
        }
      }
      if (method === "turn/completed") {
        state.turnsCompleted++;
        state.turnCompletedAt = Date.now();
        state.firstDeltaAt = null;
        state.turnStartedAt = null;
      }
    };

  allMetrics.push(collectNodeMetrics(0));

  // Phase 1: B alone (baseline event loop lag)
  log("Phase 1: B alone (baseline — 500 × 0.1KB deltas)");
  const sessionB = await startMockSession(tidB, stateB, 500, 0.1, 1, makeLabHandler(stateB, false));
  log("B ready");

  startLagMonitor();
  await sendTurn(sessionB, "baseline");
  const bEnd = Date.now() + 30_000;
  while (Date.now() < bEnd && stateB.turnsCompleted < 1) await sleep(100);
  stopLagMonitor();

  const baselineLags = [...bEventLoopLags];
  bEventLoopLags.length = 0;
  allMetrics.push(collectNodeMetrics(activeSessions.size));
  log(`Baseline: ${stateB.deltasReceived} deltas, ${baselineLags.length} lag samples, p50=${percentile(baselineLags, 50).toFixed(2)}ms, p99=${percentile(baselineLags, 99).toFixed(2)}ms, max=${baselineLags.length > 0 ? Math.max(...baselineLags).toFixed(2) : 0}ms`);

  const gcBefore = gcPauses.length;
  const heapBefore = process.memoryUsage().heapUsed;

  // Phase 2: A (heavy, retained) + B (light) concurrent
  log("\nPhase 2: A (500 × 500KB, RETAINED) + B (500 × 0.1KB) concurrent");
  log("A's deltas are kept in memory → forces old-gen promotion → mark-sweep GC");
  const sessionA = await startMockSession(tidA, stateA, 500, 500, 1, makeLabHandler(stateA, true));
  log("A ready");

  startLagMonitor();
  const turnAPromise = sendTurn(sessionA, "heavy");
  const turnBPromise = sendTurn(sessionB, "concurrent");
  await Promise.all([turnAPromise, turnBPromise]);

  // Wait for both to complete (A=1 turn total, B=2 turns total)
  const bothEnd = Date.now() + 120_000;
  while (Date.now() < bothEnd && (stateA.turnsCompleted < 1 || stateB.turnsCompleted < 2)) {
    allMetrics.push(collectNodeMetrics(activeSessions.size));
    await sleep(500);
  }
  stopLagMonitor();

  const concurrentLags = [...bEventLoopLags];
  const gcDuringConcurrent = gcPauses.slice(gcBefore);
  const heapAfter = process.memoryUsage().heapUsed;

  allMetrics.push(collectNodeMetrics(activeSessions.size));

  log(`Concurrent: ${stateB.deltasReceived} total B deltas, ${concurrentLags.length} lag samples, p50=${percentile(concurrentLags, 50).toFixed(2)}ms, p99=${percentile(concurrentLags, 99).toFixed(2)}ms, max=${concurrentLags.length > 0 ? Math.max(...concurrentLags).toFixed(2) : 0}ms`);
  log(`Heap growth: ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)}MB (retained objects: ${retainedObjects.length})`);
  log(`GC pauses during concurrent phase: ${gcDuringConcurrent.length}`);
  if (gcDuringConcurrent.length > 0) {
    const markSweeps = gcDuringConcurrent.filter((p) => p.kind === "mark-sweep");
    log(`  Mark-sweep pauses: ${markSweeps.length}, max=${Math.max(...markSweeps.map((p) => p.duration)).toFixed(2)}ms`);
    log(`  Total GC pause time: ${gcDuringConcurrent.reduce((s, p) => s + p.duration, 0).toFixed(2)}ms`);
  }

  // Capture count before cleanup
  const retainedCount = retainedObjects.length;
  retainedObjects.length = 0;
  if (gcObserver) gcObserver.disconnect();
  killAllSessions();
  await sleep(2000);
  allMetrics.push(collectNodeMetrics(0));

  const completedAt = Date.now();

  const result: TestResult = {
    test: "gc-lab",
    runtime: "node",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(states),
    summary: {
      baselineLagSamples: baselineLags.length,
      concurrentLagSamples: concurrentLags.length,
      baselineP50_ms: Math.round(percentile(baselineLags, 50) * 100) / 100,
      baselineP99_ms: Math.round(percentile(baselineLags, 99) * 100) / 100,
      baselineMax_ms: baselineLags.length > 0 ? Math.round(Math.max(...baselineLags) * 100) / 100 : 0,
      concurrentP50_ms: Math.round(percentile(concurrentLags, 50) * 100) / 100,
      concurrentP99_ms: Math.round(percentile(concurrentLags, 99) * 100) / 100,
      concurrentMax_ms: concurrentLags.length > 0 ? Math.round(Math.max(...concurrentLags) * 100) / 100 : 0,
      heapGrowthMb: Math.round((heapAfter - heapBefore) / 1024 / 1024 * 10) / 10,
      retainedObjects: retainedCount,
      gcPausesDuringConcurrent: gcDuringConcurrent.length,
      gcTotalPauseMs: Math.round(gcDuringConcurrent.reduce((s, p) => s + p.duration, 0) * 100) / 100,
      gcMarkSweepCount: gcDuringConcurrent.filter((p) => p.kind === "mark-sweep").length,
      gcMaxPauseMs: gcDuringConcurrent.length > 0
        ? Math.round(Math.max(...gcDuringConcurrent.map((p) => p.duration)) * 100) / 100
        : 0,
      sessionA_deltas: stateA.deltasReceived,
      sessionA_payloadSizeKb: 500,
      sessionB_deltas: stateB.deltasReceived,
      sessionB_payloadSizeKb: 0.1,
    },
  };

  writeResult("gc-lab", result);
  return result;
}

// ---------------------------------------------------------------------------
// Test Concurrent: 10 sessions streaming simultaneously
// ---------------------------------------------------------------------------

async function testConcurrent(): Promise<TestResult> {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST CONCURRENT: 10 sessions × 200 deltas × 10KB");
  console.log("  All streaming simultaneously in one Node process");
  console.log("═".repeat(60));

  const startedAt = Date.now();
  const N = 10;
  const states = new Map<string, SessionState>();
  const allMetrics: NodeMetricsSample[] = [];
  const sessionIds: string[] = [];
  const eventTimestamps: number[] = []; // all event receipt times

  // Event loop lag monitor
  const lags: number[] = [];
  let lagTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCheck = performance.now();
  function startLag() {
    function tick() {
      const now = performance.now();
      const lag = now - lastCheck - 1;
      if (lag > 0.5) lags.push(lag);
      lastCheck = now;
      lagTimer = setTimeout(tick, 1);
    }
    lastCheck = performance.now();
    lagTimer = setTimeout(tick, 1);
  }
  function stopLag() { if (lagTimer) clearTimeout(lagTimer); }

  allMetrics.push(collectNodeMetrics(0));

  // Start 10 mock sessions (200 deltas × 10KB each, 5ms delay)
  for (let i = 0; i < N; i++) {
    const tid = `concurrent-${i}-${Date.now()}`;
    sessionIds.push(tid);
    const state = createSessionState(tid, "mock-codex");
    states.set(tid, state);

    try {
      await startMockSession(tid, state, 200, 10, 5, (method, params) => {
        if (method === "turn/started") state.turnStartedAt = Date.now();
        if (method === "item/agentMessage/delta") {
          state.deltasReceived++;
          eventTimestamps.push(Date.now());
          if (state.firstDeltaAt === null) state.firstDeltaAt = Date.now();
        }
        if (method === "turn/completed") {
          state.turnsCompleted++;
          state.turnCompletedAt = Date.now();
          state.firstDeltaAt = null;
          state.turnStartedAt = null;
        }
      });
      log(`session[${i}] started`);
    } catch (e) {
      state.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  allMetrics.push(collectNodeMetrics(activeSessions.size));
  log(`${activeSessions.size} sessions ready`);

  // Send turns to ALL simultaneously
  log("Sending turns to all 10 sessions...");
  startLag();
  const turnPromises = sessionIds.map((tid) => {
    const session = activeSessions.get(tid);
    if (!session) return Promise.resolve();
    return sendTurn(session, "concurrent test").catch(() => {});
  });
  await Promise.all(turnPromises);
  log("All turns accepted");

  // Wait for all to complete (max 60s)
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const done = [...states.values()].every((s) => s.turnsCompleted >= 1 || s.errors.length > 0);
    if (done) break;
    allMetrics.push(collectNodeMetrics(activeSessions.size));
    await sleep(1000);
  }
  stopLag();

  const completed = [...states.values()].filter((s) => s.turnsCompleted >= 1).length;
  const totalDeltas = [...states.values()].reduce((s, st) => s + st.deltasReceived, 0);

  // Calculate event throughput
  let eventsPerSecond = 0;
  if (eventTimestamps.length > 1) {
    const duration = (eventTimestamps[eventTimestamps.length - 1]! - eventTimestamps[0]!) / 1000;
    eventsPerSecond = duration > 0 ? Math.round(eventTimestamps.length / duration) : 0;
  }

  allMetrics.push(collectNodeMetrics(activeSessions.size));

  log(`Completed: ${completed}/${N}, total deltas: ${totalDeltas}`);
  log(`Event throughput: ${eventsPerSecond} events/s`);
  log(`Event loop lag: p50=${percentile(lags, 50).toFixed(1)}ms, p99=${percentile(lags, 99).toFixed(1)}ms, max=${lags.length > 0 ? Math.max(...lags).toFixed(1) : 0}ms`);

  killAllSessions();
  await sleep(2000);
  allMetrics.push(collectNodeMetrics(0));

  const completedAt = Date.now();

  const result: TestResult = {
    test: "concurrent",
    runtime: "node",
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    metrics: allMetrics,
    sessions: Object.fromEntries(states),
    summary: {
      sessionCount: N,
      sessionsCompleted: completed,
      totalDeltas,
      eventsPerSecond,
      lagP50_ms: Math.round(percentile(lags, 50) * 100) / 100,
      lagP99_ms: Math.round(percentile(lags, 99) * 100) / 100,
      lagMax_ms: lags.length > 0 ? Math.round(Math.max(...lags) * 100) / 100 : 0,
      lagSamples: lags.length,
      peakHeap: Math.max(...allMetrics.map((m) => m.memory.heapUsed)),
      peakRss: Math.max(...allMetrics.map((m) => m.memory.rss)),
    },
  };

  writeResult("concurrent", result);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + "  T3Code Stress Test — Node/V8 Baseline".padEnd(58) + "║");
  console.log("║" + `  Tests: ${testArg}`.padEnd(58) + "║");
  console.log("║" + "  Runtime: Node (shared V8 heap, child processes)".padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // Verify codex is available
  try {
    const { execSync } = await import("node:child_process");
    execSync("codex --version", { stdio: "pipe" });
    log("codex binary available");
  } catch {
    console.error("ERROR: codex binary not found");
    process.exit(1);
  }

  const results: TestResult[] = [];

  if (testArg === "all" || testArg === "a") results.push(await testA());
  if (testArg === "all" || testArg === "b") results.push(await testB());
  if (testArg === "all" || testArg === "c") results.push(await testC());
  if (testArg === "all" || testArg === "gc-lab") results.push(await testGcLab());
  if (testArg === "all" || testArg === "concurrent") results.push(await testConcurrent());

  console.log("\n" + "═".repeat(60));
  console.log("  ALL TESTS COMPLETE");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log(`  ${r.test}: ${(r.duration_ms / 1000).toFixed(1)}s`);
  }
  console.log(`\n  Results: ${OUTPUT_DIR}/`);

  // Ensure clean exit
  killAllSessions();
  setTimeout(() => process.exit(0), 1000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  killAllSessions();
  process.exit(1);
});
