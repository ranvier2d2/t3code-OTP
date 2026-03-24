#!/usr/bin/env bun
/**
 * stress-test-exception.ts — GAP 4: Exception injection test.
 *
 * Start N sessions streaming simultaneously, then crash one mid-stream.
 * Verify the other sessions continue unaffected.
 *
 * Node: crash one child process → manager must handle the error, but the
 *   event loop continues serving other sessions (expected: no cascading).
 * Elixir: crash one GenServer → DynamicSupervisor handles it, other
 *   GenServers are completely independent (expected: zero impact).
 *
 * Uses mock provider in "crash" mode for the victim session.
 *
 * Usage:
 *   bun run scripts/stress-test-exception.ts --runtime=node
 *   bun run scripts/stress-test-exception.ts --runtime=elixir
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
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
const SURVIVOR_COUNT = 5;
const DELTA_COUNT = 200;
const DELTA_SIZE_KB = 5;
const DELAY_MS = 10;

mkdirSync(OUTPUT_DIR, { recursive: true });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

interface SessionStats {
  id: string;
  role: "victim" | "survivor";
  deltaCount: number;
  turnsCompleted: number;
  errors: string[];
  crashDetected: boolean;
  continuedAfterCrash: boolean;
}

function createStats(id: string, role: "victim" | "survivor"): SessionStats {
  return {
    id,
    role,
    deltaCount: 0,
    turnsCompleted: 0,
    errors: [],
    crashDetected: false,
    continuedAfterCrash: false,
  };
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------

async function runNode() {
  const allStats: SessionStats[] = [];
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

  function spawnMock(id: string, mode: string, deltaCount: number) {
    const child = spawn(
      "bun",
      [
        "run",
        "scripts/mock-codex-server.ts",
        String(deltaCount),
        String(DELTA_SIZE_KB),
        String(DELAY_MS),
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

  // Start victim session (will crash after ~10 deltas)
  const victimId = `victim-node-${Date.now()}`;
  const victimStats = createStats(victimId, "victim");
  allStats.push(victimStats);

  const victimSession = spawnMock(victimId, "crash", DELTA_COUNT);
  victimSession.rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const p = victimSession.pending.get(msg.id);
        if (p) {
          victimSession.pending.delete(msg.id);
          if (msg.error) {
            p.reject(
              new Error(
                typeof msg.error === "object" ? JSON.stringify(msg.error) : String(msg.error),
              ),
            );
          } else {
            p.resolve(msg.result);
          }
        }
        return;
      }
      if (msg.method === "item/agentMessage/delta") victimStats.deltaCount++;
      if (msg.method === "turn/completed") victimStats.turnsCompleted++;
    } catch {}
  });

  victimSession.child.on("exit", (code) => {
    victimStats.crashDetected = true;
    victimStats.errors.push(`Process crashed with exit code ${code}`);
    log(`VICTIM CRASHED (exit code ${code}) after ${victimStats.deltaCount} deltas`);
  });

  await rpc(victimSession, "initialize", {
    clientInfo: { name: "stress", version: "1.0" },
    capabilities: {},
  });
  victimSession.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const victimThread = await rpc(victimSession, "thread/start", { cwd: process.cwd() });
  victimSession.codexThreadId = victimThread?.thread?.id ?? null;

  // Start survivor sessions (normal mode, will complete)
  const survivorSessions: Array<{ session: ReturnType<typeof spawnMock>; stats: SessionStats }> =
    [];
  for (let i = 0; i < SURVIVOR_COUNT; i++) {
    const sid = `survivor-node-${i}-${Date.now()}`;
    const stats = createStats(sid, "survivor");
    allStats.push(stats);

    const session = spawnMock(sid, "normal", DELTA_COUNT);
    session.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = session.pending.get(msg.id);
          if (p) {
            session.pending.delete(msg.id);
            if (msg.error) {
              p.reject(
                new Error(
                  typeof msg.error === "object" ? JSON.stringify(msg.error) : String(msg.error),
                ),
              );
            } else {
              p.resolve(msg.result);
            }
          }
          return;
        }
        if (msg.method === "item/agentMessage/delta") {
          stats.deltaCount++;
          // Check if this happened after the victim crashed
          if (victimStats.crashDetected) stats.continuedAfterCrash = true;
        }
        if (msg.method === "turn/completed") stats.turnsCompleted++;
      } catch {}
    });

    await rpc(session, "initialize", {
      clientInfo: { name: "stress", version: "1.0" },
      capabilities: {},
    });
    session.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const sThread = await rpc(session, "thread/start", { cwd: process.cwd() });
    session.codexThreadId = sThread?.thread?.id ?? null;
    survivorSessions.push({ session, stats });
  }

  log(`1 victim + ${SURVIVOR_COUNT} survivors ready`);

  // Send turns to ALL simultaneously (victim will crash mid-stream)
  log("Sending turns to all sessions (victim will crash mid-stream)...");

  rpc(victimSession, "turn/start", {
    threadId: victimSession.codexThreadId,
    input: [{ type: "text", text: "crash test" }],
  }).catch(() => {});

  for (const { session, stats } of survivorSessions) {
    rpc(session, "turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: "survivor test" }],
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for all survivors to complete (max 60s)
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const survivorsCompleted = survivorSessions.every(
      ({ stats }) => stats.turnsCompleted > 0 || stats.errors.length > 0,
    );
    if (survivorsCompleted) break;
    await sleep(500);
  }

  // Kill remaining
  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return { allStats };
}

// ---------------------------------------------------------------------------
// Elixir runtime
// ---------------------------------------------------------------------------

async function runElixir() {
  if (!HarnessClientManager) throw new Error("HarnessClientManager not available — import failed");
  const allStats: SessionStats[] = [];
  let victimCrashTime: number | null = null;

  const mgr = new HarnessClientManager({
    harnessPort: HARNESS_PORT,
    harnessSecret: HARNESS_SECRET,
    onEvent: (raw: any) => {
      const stats = allStats.find((s) => s.id === raw.threadId);
      if (!stats) return;

      if (raw.method === "item/agentMessage/delta") {
        stats.deltaCount++;
        if (stats.role === "survivor" && victimCrashTime != null) {
          stats.continuedAfterCrash = true;
        }
      }
      if (raw.method === "turn/completed") stats.turnsCompleted++;
      if (raw.method === "session/exited" || raw.method === "session/error") {
        if (stats.role === "victim") {
          stats.crashDetected = true;
          victimCrashTime = Date.now();
          log(`VICTIM CRASHED after ${stats.deltaCount} deltas`);
        }
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
  });

  await mgr.connect();
  log("Connected to harness");

  const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;

  // Start victim session (crash mode)
  const victimId = `victim-elixir-${Date.now()}`;
  const victimStats = createStats(victimId, "victim");
  allStats.push(victimStats);

  await mgr.startSession({
    threadId: victimId,
    provider: "mock",
    cwd: process.cwd(),
    providerOptions: {
      mock: {
        deltaCount: DELTA_COUNT,
        deltaSizeKb: DELTA_SIZE_KB,
        delayMs: DELAY_MS,
        mode: "crash",
      },
    },
  });

  // Start survivor sessions (normal mode)
  for (let i = 0; i < SURVIVOR_COUNT; i++) {
    const sid = `survivor-elixir-${i}-${Date.now()}`;
    const stats = createStats(sid, "survivor");
    allStats.push(stats);

    await mgr.startSession({
      threadId: sid,
      provider: "mock",
      cwd: process.cwd(),
      providerOptions: {
        mock: {
          deltaCount: DELTA_COUNT,
          deltaSizeKb: DELTA_SIZE_KB,
          delayMs: DELAY_MS,
          mode: "normal",
        },
      },
    });
  }

  log(`1 victim + ${SURVIVOR_COUNT} survivors ready`);

  // Check metrics before
  let preMetrics: any = { sessions: [], beam: { process_count: 0 } };
  try {
    const res = await fetch(METRICS_URL);
    if (res.ok) preMetrics = await res.json();
  } catch (e) {
    log(`Warning: Could not fetch pre-crash metrics: ${e}`);
  }
  const preSessions = (preMetrics.sessions ?? []).length;
  log(
    `Pre-crash: ${preSessions} sessions active, ${preMetrics.beam?.process_count ?? 0} BEAM processes`,
  );

  // Send turns to ALL
  log("Sending turns to all sessions (victim will crash mid-stream)...");
  for (const stats of allStats) {
    mgr
      .sendTurn(stats.id, {
        input: [{ type: "text", text: stats.role === "victim" ? "crash test" : "survivor test" }],
      })
      .catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  // Wait for survivors to complete (max 60s)
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const survivorsCompleted = allStats
      .filter((s) => s.role === "survivor")
      .every((s) => s.turnsCompleted > 0 || s.errors.length > 0);
    if (survivorsCompleted) break;
    await sleep(500);
  }

  // Post-crash metrics
  let postMetrics: any = { sessions: [], beam: { process_count: 0 } };
  try {
    const res = await fetch(METRICS_URL);
    if (res.ok) postMetrics = await res.json();
  } catch (e) {
    log(`Warning: Could not fetch post-crash metrics: ${e}`);
  }
  const postSessions = (postMetrics.sessions ?? []).length;
  log(`Post-crash: ${postSessions} sessions active (victim should be gone)`);

  try {
    await mgr.stopAll();
  } catch {}
  mgr.disconnect();

  return { allStats, preSessionCount: preSessions, postSessionCount: postSessions };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  GAP 4: Exception Injection Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log("║" + `  1 victim (crash) + ${SURVIVOR_COUNT} survivors (normal)`.padEnd(58) + "║");
  console.log("║" + `  Verify crash isolation`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log("  EXCEPTION INJECTION RESULTS");
  console.log("═".repeat(60));

  const { allStats } = result;
  const victim = allStats.find((s) => s.role === "victim")!;
  const survivors = allStats.filter((s) => s.role === "survivor");

  console.log(`\n  Victim:`);
  console.log(`    Crash detected: ${victim.crashDetected ? "YES" : "NO"}`);
  console.log(`    Deltas before crash: ${victim.deltaCount}`);

  console.log(`\n  Survivors (${survivors.length}):`);
  let allSurvived = true;
  for (const s of survivors) {
    const ok = s.turnsCompleted > 0 && s.errors.length === 0;
    if (!ok) allSurvived = false;
    console.log(
      `    [${s.id.slice(0, 30)}] turns=${s.turnsCompleted} deltas=${s.deltaCount} continuedAfterCrash=${s.continuedAfterCrash} ${ok ? "OK" : "FAILED"}`,
    );
  }

  const someSurvivorContinuedAfterCrash = survivors.some((s) => s.continuedAfterCrash);
  const isolationVerified = victim.crashDetected && allSurvived && someSurvivorContinuedAfterCrash;
  console.log(
    `\n  CRASH ISOLATION: ${isolationVerified ? "VERIFIED — crash did NOT cascade" : "FAILED"}`,
  );

  if (RUNTIME === "elixir" && "preSessionCount" in result) {
    const r = result as any;
    console.log(
      `  Sessions: ${r.preSessionCount} → ${r.postSessionCount} (victim removed by DynamicSupervisor)`,
    );
  }

  const output = {
    test: "exception-injection",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: {
      survivorCount: SURVIVOR_COUNT,
      deltaCount: DELTA_COUNT,
      deltaSizeKb: DELTA_SIZE_KB,
      delayMs: DELAY_MS,
    },
    victim: {
      id: victim.id,
      crashDetected: victim.crashDetected,
      deltasBeforeCrash: victim.deltaCount,
      errors: victim.errors,
    },
    survivors: survivors.map((s) => ({
      id: s.id,
      turnsCompleted: s.turnsCompleted,
      deltaCount: s.deltaCount,
      continuedAfterCrash: s.continuedAfterCrash,
      errors: s.errors,
    })),
    summary: {
      crashIsolationVerified: isolationVerified,
      victimCrashed: victim.crashDetected,
      survivorsCompleted: survivors.filter((s) => s.turnsCompleted > 0).length,
      survivorsContinuedAfterCrash: survivors.filter((s) => s.continuedAfterCrash).length,
      totalSurvivors: survivors.length,
    },
  };

  const filename = `${RUNTIME}-exception-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(60));

  setTimeout(() => process.exit(0), 2000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
