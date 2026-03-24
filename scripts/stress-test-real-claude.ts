#!/usr/bin/env bun
/**
 * stress-test-real-claude.ts — Real Claude Code stress test.
 *
 * Spawns N concurrent Claude Code sessions with complex tasks that
 * naturally trigger tool use (file creation, editing, command execution).
 * Claude Code uses its own Agent tool for subagent-like delegation.
 *
 * Measures event throughput, memory behavior, tool call patterns,
 * and compares Node (direct spawn) vs Elixir (harness) routing.
 *
 * Usage:
 *   bun run scripts/stress-test-real-claude.ts --runtime=node
 *   bun run scripts/stress-test-real-claude.ts --runtime=elixir
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

let HarnessClientManager: any;
try {
  const mod = await import("../apps/server/src/provider/Layers/HarnessClientManager.ts");
  HarnessClientManager = mod.HarnessClientManager;
} catch (err) {
  console.warn("Failed to import HarnessClientManager:", err);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const RUNTIME = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1] || "node";
const HARNESS_PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const HARNESS_SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const N = Number(process.argv.find((a) => a.startsWith("--sessions="))?.split("=")[1] || 2);
const TEST_DURATION_MS = 10 * 60 * 1000;
const METRICS_INTERVAL_MS = 5000;

mkdirSync(OUTPUT_DIR, { recursive: true });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Prompts — complex multi-tool tasks
// ---------------------------------------------------------------------------

const CLAUDE_PROMPTS = [
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
];

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------

interface SessionStats {
  name: string;
  threadId: string;
  totalEvents: number;
  contentDeltas: number;
  toolCalls: number;
  fileChanges: number;
  commandExecs: number;
  turnsCompleted: number;
  errors: string[];
  totalPayloadBytes: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  eventTypes: Record<string, number>;
}

function createStats(name: string, threadId: string): SessionStats {
  return {
    name,
    threadId,
    totalEvents: 0,
    contentDeltas: 0,
    toolCalls: 0,
    fileChanges: 0,
    commandExecs: 0,
    turnsCompleted: 0,
    errors: [],
    totalPayloadBytes: 0,
    firstEventAt: null,
    lastEventAt: null,
    eventTypes: {},
  };
}

function trackEvent(stats: SessionStats, method: string, payload: unknown) {
  stats.totalEvents++;
  const now = Date.now();
  if (!stats.firstEventAt) stats.firstEventAt = now;
  stats.lastEventAt = now;

  try {
    stats.totalPayloadBytes += JSON.stringify(payload).length;
  } catch {}

  // Count event types
  stats.eventTypes[method] = (stats.eventTypes[method] || 0) + 1;

  // Classify
  if (
    method === "content/delta" ||
    method === "content_block_delta" ||
    method === "item/agentMessage/delta"
  ) {
    stats.contentDeltas++;
  } else if (method === "item/started" || method === "content_block_start") {
    const p = payload as Record<string, unknown>;
    const contentBlock = p?.content_block as Record<string, unknown> | undefined;
    const itemType = String(p?.itemType || contentBlock?.type || "");
    if (itemType.includes("file") || itemType.includes("edit") || itemType.includes("write")) {
      stats.fileChanges++;
    } else if (itemType.includes("command") || itemType.includes("bash")) {
      stats.commandExecs++;
    }
    stats.toolCalls++;
  } else if (method === "turn/completed" || method === "result") {
    stats.turnsCompleted++;
  }
}

// ---------------------------------------------------------------------------
// Node runtime — spawn claude --print directly
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: SessionStats[] = [];
  const timeSeries: Array<{
    elapsed_ms: number;
    heapUsed: number;
    rss: number;
    totalEvents: number;
  }> = [];

  const lags: number[] = [];
  let lastLagCheck = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastLagCheck - 100;
    if (lag > 5) lags.push(lag);
    lastLagCheck = now;
  }, 100);

  const children: ChildProcess[] = [];

  for (let i = 0; i < N; i++) {
    const workload = CLAUDE_PROMPTS[i % CLAUDE_PROMPTS.length]!;
    const tid = `claude-node-${workload.name}-${i}-${Date.now()}`;
    const workDir = `/tmp/t3code-claude-${workload.name}-${i}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    // Spawn claude --print with stream-json output (array form avoids shell injection)
    const child = spawn(
      "claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "claude-sonnet-4-6",
        workload.prompt,
      ],
      {
        cwd: workDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);

    // Parse stream-json output line by line
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          const type = msg.type || "unknown";
          trackEvent(stats, type, msg);
        } catch {}
      }
    });

    child.stderr?.resume();
    child.on("exit", (code) => {
      if (code !== 0) stats.errors.push(`Exit code ${code}`);
      if (code === 0 && stats.turnsCompleted === 0) stats.turnsCompleted = 1; // claude --print = 1 turn
    });

    log(`[${workload.name}] spawned (cwd: ${workDir})`);
  }

  log(`${children.length} Claude sessions spawned. Monitoring...\n`);

  // Monitor
  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);
    const mem = process.memoryUsage();
    const totalEvents = allStats.reduce((s, st) => s + st.totalEvents, 0);
    timeSeries.push({
      elapsed_ms: Date.now() - t0,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      totalEvents,
    });

    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    const tools = allStats.reduce((s, st) => s + st.toolCalls, 0);
    process.stdout.write(
      `\r  ${ts()} events=${totalEvents} tools=${tools} completed=${completed}/${allStats.length} heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    );

    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) {
      log("\nAll sessions completed");
      break;
    }
  }

  clearInterval(lagTimer);
  console.log("");
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }

  return { allStats, timeSeries, lags };
}

// ---------------------------------------------------------------------------
// Elixir runtime — through harness
// ---------------------------------------------------------------------------

async function runElixir() {
  if (!HarnessClientManager) throw new Error("HarnessClientManager not available — import failed");
  const allStats: SessionStats[] = [];
  const timeSeries: Array<{
    elapsed_ms: number;
    beamTotalMemory: number;
    beamProcessCount: number;
    totalEvents: number;
  }> = [];

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

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;

  for (let i = 0; i < N; i++) {
    const workload = CLAUDE_PROMPTS[i % CLAUDE_PROMPTS.length]!;
    const tid = `claude-elixir-${workload.name}-${i}-${Date.now()}`;
    const workDir = `/tmp/t3code-claude-${workload.name}-${i}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: tid,
        provider: "claudeAgent",
        cwd: workDir,
        runtimeMode: "full-access",
        model: "claude-sonnet-4-6",
      });
      log(`[${workload.name}] ready (cwd: ${workDir})`);
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      log(`[${workload.name}] FAILED: ${stats.errors[0]}`);
    }
  }

  log(`${allStats.filter((s) => s.errors.length === 0).length} sessions ready, sending tasks...\n`);

  for (let i = 0; i < allStats.length; i++) {
    const stats = allStats[i]!;
    if (stats.errors.length > 0) continue;

    mgr
      .sendTurn(stats.threadId, {
        input: [{ type: "text", text: CLAUDE_PROMPTS[i]!.prompt }],
      })
      .catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);
    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      const totalEvents = allStats.reduce((s, st) => s + st.totalEvents, 0);
      timeSeries.push({
        elapsed_ms: Date.now() - t0,
        beamTotalMemory: m.beam.total_memory,
        beamProcessCount: m.beam.process_count,
        totalEvents,
      });

      const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
      const tools = allStats.reduce((s, st) => s + st.toolCalls, 0);
      process.stdout.write(
        `\r  ${ts()} events=${totalEvents} tools=${tools} completed=${completed}/${allStats.length} mem=${(m.beam.total_memory / 1024 / 1024).toFixed(1)}MB`,
      );
    } catch {}

    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) {
      log("\nAll sessions completed");
      break;
    }
  }

  console.log("");
  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return { allStats, timeSeries, lags: [] as number[] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sessionCount = N;
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  REAL Claude Code Stress Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  ${sessionCount} sessions with full tool access`.padEnd(58) + "║");
  console.log("║" + `  Model: claude-sonnet-4-6`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  const { allStats, timeSeries, lags } = result;

  console.log("\n" + "═".repeat(70));
  console.log("  REAL CLAUDE CODE STRESS TEST RESULTS");
  console.log("═".repeat(70));

  for (const stats of allStats) {
    const duration =
      stats.lastEventAt && stats.firstEventAt
        ? ((stats.lastEventAt - stats.firstEventAt) / 1000).toFixed(0)
        : "?";
    console.log(`\n  [${stats.name}]`);
    console.log(`    Events: ${stats.totalEvents} (${stats.contentDeltas} content deltas)`);
    console.log(
      `    Tool calls: ${stats.toolCalls} (${stats.fileChanges} files, ${stats.commandExecs} commands)`,
    );
    console.log(`    Turns: ${stats.turnsCompleted}`);
    console.log(`    Payload: ${(stats.totalPayloadBytes / 1024).toFixed(0)}KB`);
    console.log(`    Duration: ${duration}s`);
    if (stats.errors.length > 0) console.log(`    ERRORS: ${stats.errors.join(", ")}`);

    // Top event types
    const sorted = Object.entries(stats.eventTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    console.log(`    Top events: ${sorted.map(([k, v]) => `${k}(${v})`).join(", ")}`);
  }

  const totalEvents = allStats.reduce((s, st) => s + st.totalEvents, 0);
  const totalTools = allStats.reduce((s, st) => s + st.toolCalls, 0);
  const totalPayload = allStats.reduce((s, st) => s + st.totalPayloadBytes, 0);
  const duration = (completedAt - startedAt) / 1000;

  console.log(`\n  Summary:`);
  console.log(
    `    Sessions: ${allStats.filter((s) => s.turnsCompleted > 0).length}/${allStats.length} completed`,
  );
  console.log(`    Total events: ${totalEvents}`);
  console.log(`    Total tool calls: ${totalTools}`);
  console.log(`    Total payload: ${(totalPayload / 1024).toFixed(0)}KB`);
  console.log(`    Duration: ${duration.toFixed(0)}s`);

  if (RUNTIME === "node" && lags.length > 0) {
    const sorted = [...lags].sort((a, b) => a - b);
    console.log(
      `    Event loop lag: p50=${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)}ms p99=${sorted[Math.floor(sorted.length * 0.99)]?.toFixed(1)}ms`,
    );
  }

  const output = {
    test: "real-claude",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: { sessions: allStats.length, model: "claude-sonnet-4-6" },
    sessions: allStats,
    timeSeries,
    summary: {
      sessionCount: allStats.length,
      completed: allStats.filter((s) => s.turnsCompleted > 0).length,
      totalEvents,
      totalToolCalls: totalTools,
      totalPayloadKb: Math.round(totalPayload / 1024),
      duration_s: Math.round(duration),
    },
  };

  const filename = `${RUNTIME}-real-claude-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(70));

  setTimeout(() => process.exit(0), 3000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
