#!/usr/bin/env bun
/**
 * stress-test-real-subagent.ts — Real Codex subagent stress test.
 *
 * Spawns N concurrent Codex sessions with experimentalApi + plan mode
 * to trigger real subagent delegation. Each session gets a complex
 * multi-service task that naturally requires subagent spawning.
 *
 * This is NOT a mock test. It uses real Codex API calls.
 *
 * Measures:
 *   - Subagent lifecycle events (spawn_begin/end, interaction_begin/end)
 *   - Event routing complexity (parent vs subagent event interleaving)
 *   - Memory/GC behavior under subagent tree load
 *   - Total event count and types
 *
 * Usage:
 *   bun run scripts/stress-test-real-subagent.ts --runtime=node
 *   bun run scripts/stress-test-real-subagent.ts --runtime=elixir
 *
 * Prerequisites:
 *   - codex binary available
 *   - Elixir harness running on port 4321 (for --runtime=elixir)
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
const N = Number(process.argv.find((a) => a.startsWith("--sessions="))?.split("=")[1] || 2);
const TEST_DURATION_MS = 10 * 60 * 1000; // 10 min max
const METRICS_INTERVAL_MS = 5000;

mkdirSync(OUTPUT_DIR, { recursive: true });

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Prompts — complex enough to trigger subagent delegation
// ---------------------------------------------------------------------------

const SUBAGENT_PROMPTS = [
  {
    name: "microservices",
    prompt: `Build a complete microservices system in this directory with THREE separate services. Each service should be its own TypeScript module:

1. **Auth Service** (auth.ts): JWT token generation and validation. Include createToken(userId, role) and validateToken(token) functions. Use a hardcoded secret key.

2. **Posts Service** (posts.ts): CRUD for blog posts. In-memory storage. Functions: createPost(authorId, title, body), getPost(id), listPosts(authorId), deletePost(id). Each post should have id, authorId, title, body, createdAt.

3. **Comments Service** (comments.ts): Comments on posts. In-memory storage. Functions: addComment(postId, authorId, text), getComments(postId), deleteComment(id).

4. **Integration test** (test.ts): Test the full flow — create a token, use it to create a post, add comments to the post, list all comments, delete a comment, verify it's gone.

Delegate each service to a subagent if possible. Run the tests and make sure they pass. All code in this directory, no external packages.`,
  },
  {
    name: "data-pipeline",
    prompt: `Build a data processing pipeline in this directory with THREE processing stages. Each stage should be its own TypeScript module:

1. **Ingestion Stage** (ingest.ts): Parse CSV data from a string. Handle headers, quoted fields, type coercion (numbers, booleans, dates). Export a parse(csvString) function that returns an array of typed objects.

2. **Transform Stage** (transform.ts): Data transformations. Export functions: filterBy(data, field, predicate), groupBy(data, field), aggregate(groups, field, operation), sortBy(data, field, order). Operations: sum, avg, min, max, count.

3. **Output Stage** (output.ts): Format results. Export functions: toMarkdownTable(data), toJSON(data, pretty?), toCSV(data), summarize(data) which returns {rowCount, columns, types, nullCounts}.

4. **Pipeline runner** (pipeline.ts): Chain the stages. Create sample CSV data with at least 20 rows of sales data (date, product, region, amount, quantity). Run: parse → filter (amount > 100) → group by region → aggregate sum of amount → output as markdown table.

5. **Tests** (test.ts): Test each stage independently + the full pipeline. At least 15 test cases.

Delegate each stage to a subagent if possible. Run everything. All code in this directory.`,
  },
  {
    name: "game-engine",
    prompt: `Build a simple game engine in this directory with THREE core systems. Each system should be its own TypeScript module:

1. **Entity System** (entity.ts): An ECS (Entity Component System). Entity is just an ID. Components are typed data objects attached to entities. Systems iterate over entities with specific component sets. Export: createWorld(), addEntity(world), addComponent(world, entityId, component), removeEntity(world, entityId), query(world, componentTypes).

2. **Physics System** (physics.ts): 2D physics with position, velocity, and collision detection. Components: Position {x, y}, Velocity {dx, dy}, Collider {width, height}. Functions: updatePositions(world, dt), detectCollisions(world) returning collision pairs, resolveCollisions(pairs).

3. **Rendering System** (renderer.ts): Text-based rendering to a 2D grid. Components: Sprite {char}. Functions: createGrid(width, height), renderWorld(world, grid) placing sprites at positions, gridToString(grid).

4. **Game loop** (game.ts): Create a world with 5 entities (player '@', 3 enemies 'E', 1 wall '#'). Run 10 simulation steps. Each step: update positions, detect collisions, resolve, render, print the grid.

5. **Tests** (test.ts): Test each system. At least 12 test cases covering entity CRUD, physics updates, collision detection, and rendering.

Delegate each system to a subagent if possible. Run everything. All code in this directory.`,
  },
];

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------

interface SubagentEventLog {
  timestamp: number;
  method: string;
  agentId?: string;
  agentName?: string;
  turnId?: string;
  payloadSize: number;
}

interface SessionStats {
  name: string;
  threadId: string;
  events: SubagentEventLog[];
  deltasReceived: number;
  subagentSpawns: number;
  subagentCompletions: number;
  interactionBegins: number;
  interactionEnds: number;
  collabWaiting: number;
  toolCalls: number;
  turnsCompleted: number;
  errors: string[];
  totalPayloadBytes: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

function createStats(name: string, threadId: string): SessionStats {
  return {
    name,
    threadId,
    events: [],
    deltasReceived: 0,
    subagentSpawns: 0,
    subagentCompletions: 0,
    interactionBegins: 0,
    interactionEnds: 0,
    collabWaiting: 0,
    toolCalls: 0,
    turnsCompleted: 0,
    errors: [],
    totalPayloadBytes: 0,
    firstEventAt: null,
    lastEventAt: null,
  };
}

function trackEvent(stats: SessionStats, method: string, payload: unknown) {
  const now = Date.now();
  if (!stats.firstEventAt) stats.firstEventAt = now;
  stats.lastEventAt = now;

  let payloadSize = 0;
  try {
    payloadSize = JSON.stringify(payload).length;
  } catch {}
  stats.totalPayloadBytes += payloadSize;

  const p = payload as Record<string, unknown>;
  // Strip codex/event/ prefix for matching
  const m = method.replace("codex/event/", "");

  // Log subagent-related events with full detail
  const logEntry: SubagentEventLog = {
    timestamp: now,
    method,
    payloadSize,
  };

  if (p?.agentId) logEntry.agentId = String(p.agentId);
  if (p?.agentName) logEntry.agentName = String(p.agentName);
  if (p?.turnId) logEntry.turnId = String(p.turnId);

  // Only log interesting events (not every delta)
  const isInteresting =
    method.includes("collab") ||
    method.includes("spawn") ||
    method.includes("interaction") ||
    method.includes("waiting") ||
    method.includes("terminal") ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "item/started" ||
    method === "item/completed" ||
    m === "task_started" ||
    m === "task_complete";

  if (isInteresting) stats.events.push(logEntry);

  // Match both raw method names and codex/event/ prefixed versions
  if (
    method === "item/agentMessage/delta" ||
    method === "content/delta" ||
    m === "agent_message_content_delta" ||
    m === "agent_message_delta"
  ) {
    stats.deltasReceived++;
  } else if (m === "collab_agent_spawn_begin") {
    stats.subagentSpawns++;
  } else if (m === "collab_agent_spawn_end") {
    stats.subagentCompletions++;
  } else if (m === "collab_agent_interaction_begin") {
    stats.interactionBegins++;
  } else if (m === "collab_agent_interaction_end") {
    stats.interactionEnds++;
  } else if (m === "collab_waiting_begin") {
    stats.collabWaiting++;
  } else if (method === "item/started" || m === "item_started") {
    stats.toolCalls++;
  } else if (method === "turn/completed" || m === "task_complete") {
    stats.turnsCompleted++;
  }
}

// ---------------------------------------------------------------------------
// Node runtime
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

  // Start N sessions with experimentalApi
  for (let i = 0; i < Math.min(N, SUBAGENT_PROMPTS.length); i++) {
    const workload = SUBAGENT_PROMPTS[i]!;
    const tid = `real-subagent-${workload.name}-${Date.now()}`;
    const workDir = `/tmp/t3code-subagent-${workload.name}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    const child = spawn("codex", ["app-server"], {
      cwd: workDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const session = {
      child,
      rl,
      pending: new Map<number, any>(),
      nextId: 1,
      codexThreadId: null as string | null,
    };
    sessions.set(tid, session);

    rl.on("line", (line: string) => {
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
        if (msg.method) trackEvent(stats, msg.method, msg.params);
      } catch {}
    });
    child.stderr?.resume();

    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, 120000);
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
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      // experimentalApi: true enables subagent collaboration
      await rpc("initialize", {
        clientInfo: { name: "stress", version: "1.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const threadResult = await rpc("thread/start", {
        cwd: workDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      session.codexThreadId = threadResult?.thread?.id ?? null;
      log(`[${workload.name}] ready (cwd: ${workDir})`);
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      log(`[${workload.name}] FAILED: ${stats.errors[0]}`);
    }
  }

  log(`${sessions.size} sessions ready, sending subagent tasks with plan mode...`);

  // Send turns with collaborationMode: plan
  for (let i = 0; i < allStats.length; i++) {
    const stats = allStats[i]!;
    const session = sessions.get(stats.threadId);
    if (!session || stats.errors.length > 0) continue;

    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = session.nextId++;
        const timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new Error("timeout"));
        }, 120000);
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

    rpc("turn/start", {
      threadId: session.codexThreadId,
      input: [{ type: "text", text: SUBAGENT_PROMPTS[i]!.prompt }],
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "high",
          developer_instructions:
            "You MUST delegate each service/stage/system to a separate subagent. Do not implement everything yourself — spawn subagents for each module.",
        },
      },
    }).catch((e) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  log("All tasks sent with plan mode (gpt-5.4). Monitoring...\n");

  // Monitor
  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);

    const mem = process.memoryUsage();
    const totalEvents = allStats.reduce((s, st) => s + st.events.length + st.deltasReceived, 0);
    timeSeries.push({
      elapsed_ms: Date.now() - t0,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      totalEvents,
    });

    const spawns = allStats.reduce((s, st) => s + st.subagentSpawns, 0);
    const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
    process.stdout.write(
      `\r  ${ts()} events=${totalEvents} spawns=${spawns} completed=${completed}/${allStats.length} heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    );

    if (allStats.every((s) => s.turnsCompleted > 0 || s.errors.length > 0)) {
      log("\nAll sessions completed");
      break;
    }
  }

  clearInterval(lagTimer);
  console.log("");

  for (const [, session] of sessions) {
    try {
      session.child.kill();
    } catch {}
  }

  return { allStats, timeSeries, lags };
}

// ---------------------------------------------------------------------------
// Elixir runtime
// ---------------------------------------------------------------------------

async function runElixir() {
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

  for (let i = 0; i < Math.min(N, SUBAGENT_PROMPTS.length); i++) {
    const workload = SUBAGENT_PROMPTS[i]!;
    const tid = `real-subagent-elixir-${workload.name}-${Date.now()}`;
    const workDir = `/tmp/t3code-subagent-${workload.name}-${Date.now()}`;
    mkdirSync(workDir, { recursive: true });

    const stats = createStats(workload.name, tid);
    allStats.push(stats);

    try {
      await mgr.startSession({
        threadId: tid,
        provider: "codex",
        cwd: workDir,
        runtimeMode: "full-access",
        providerOptions: {
          codex: { experimentalApi: true },
        },
      });
      log(`[${workload.name}] ready (cwd: ${workDir})`);
    } catch (e) {
      stats.errors.push(e instanceof Error ? e.message : String(e));
      log(`[${workload.name}] FAILED: ${stats.errors[0]}`);
    }
  }

  log(
    `${allStats.filter((s) => s.errors.length === 0).length} sessions ready, sending subagent tasks with plan mode...`,
  );

  for (let i = 0; i < allStats.length; i++) {
    const stats = allStats[i]!;
    if (stats.errors.length > 0) continue;

    mgr
      .sendTurn(stats.threadId, {
        input: [{ type: "text", text: SUBAGENT_PROMPTS[i]!.prompt }],
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            reasoning_effort: "high",
            developer_instructions:
              "You MUST delegate each service/stage/system to a separate subagent. Do not implement everything yourself — spawn subagents for each module.",
          },
        },
      })
      .catch((e: any) => stats.errors.push(e instanceof Error ? e.message : String(e)));
  }

  log("All tasks sent with plan mode (gpt-5.4). Monitoring...\n");

  const testEnd = Date.now() + TEST_DURATION_MS;
  while (Date.now() < testEnd) {
    await sleep(METRICS_INTERVAL_MS);

    try {
      const m = (await fetch(METRICS_URL).then((r) => r.json())) as any;
      const totalEvents = allStats.reduce((s, st) => s + st.events.length + st.deltasReceived, 0);
      timeSeries.push({
        elapsed_ms: Date.now() - t0,
        beamTotalMemory: m.beam.total_memory,
        beamProcessCount: m.beam.process_count,
        totalEvents,
      });

      const spawns = allStats.reduce((s, st) => s + st.subagentSpawns, 0);
      const completed = allStats.filter((s) => s.turnsCompleted > 0).length;
      process.stdout.write(
        `\r  ${ts()} events=${totalEvents} spawns=${spawns} completed=${completed}/${allStats.length} mem=${(m.beam.total_memory / 1024 / 1024).toFixed(1)}MB procs=${m.beam.process_count}`,
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
  const sessionCount = Math.min(N, SUBAGENT_PROMPTS.length);
  console.log("\n" + "╔" + "═".repeat(58) + "╗");
  console.log("║" + `  REAL Subagent Stress Test — ${RUNTIME}`.padEnd(58) + "║");
  console.log(
    "║" + `  ${sessionCount} Codex sessions with experimentalApi + plan mode`.padEnd(58) + "║",
  );
  console.log("║" + `  Each task designed to trigger subagent delegation`.padEnd(58) + "║");
  console.log("║" + `  Max duration: ${TEST_DURATION_MS / 1000 / 60} minutes`.padEnd(58) + "║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  const startedAt = Date.now();
  const result = RUNTIME === "elixir" ? await runElixir() : await runNode();
  const completedAt = Date.now();

  const { allStats, timeSeries, lags } = result;

  // Summary
  console.log("\n" + "═".repeat(70));
  console.log("  REAL SUBAGENT STRESS TEST RESULTS");
  console.log("═".repeat(70));

  for (const stats of allStats) {
    const duration =
      stats.lastEventAt && stats.firstEventAt
        ? ((stats.lastEventAt - stats.firstEventAt) / 1000).toFixed(0)
        : "?";
    console.log(`\n  [${stats.name}]`);
    console.log(
      `    Events: ${stats.events.length + stats.deltasReceived} total (${stats.deltasReceived} deltas)`,
    );
    console.log(
      `    Subagents: ${stats.subagentSpawns} spawned, ${stats.subagentCompletions} completed`,
    );
    console.log(`    Interactions: ${stats.interactionBegins} begin, ${stats.interactionEnds} end`);
    console.log(`    Collab waiting: ${stats.collabWaiting}`);
    console.log(`    Tool calls: ${stats.toolCalls}`);
    console.log(`    Turns: ${stats.turnsCompleted} completed`);
    console.log(`    Payload: ${(stats.totalPayloadBytes / 1024).toFixed(0)}KB`);
    console.log(`    Duration: ${duration}s`);
    if (stats.errors.length > 0) console.log(`    ERRORS: ${stats.errors.join(", ")}`);

    // Show subagent lifecycle events
    const subagentEvents = stats.events.filter(
      (e) =>
        e.method.includes("collab") ||
        e.method.includes("spawn") ||
        e.method.includes("interaction"),
    );
    if (subagentEvents.length > 0) {
      console.log(`    Subagent event timeline:`);
      for (const e of subagentEvents.slice(0, 20)) {
        const t = ((e.timestamp - (stats.firstEventAt ?? e.timestamp)) / 1000).toFixed(1);
        const agent = e.agentName
          ? ` [${e.agentName}]`
          : e.agentId
            ? ` [${e.agentId.slice(0, 8)}]`
            : "";
        console.log(`      +${t}s ${e.method}${agent}`);
      }
      if (subagentEvents.length > 20)
        console.log(`      ... and ${subagentEvents.length - 20} more`);
    }
  }

  const totalSpawns = allStats.reduce((s, st) => s + st.subagentSpawns, 0);
  const totalCompletions = allStats.reduce((s, st) => s + st.subagentCompletions, 0);
  const totalEvents = allStats.reduce((s, st) => s + st.events.length + st.deltasReceived, 0);
  const totalCompleted = allStats.filter((s) => s.turnsCompleted > 0).length;
  const duration = (completedAt - startedAt) / 1000;

  console.log(`\n  Summary:`);
  console.log(`    Sessions: ${totalCompleted}/${allStats.length} completed`);
  console.log(`    Total subagent spawns: ${totalSpawns}`);
  console.log(`    Total subagent completions: ${totalCompletions}`);
  console.log(`    Total events: ${totalEvents}`);
  console.log(`    Duration: ${duration.toFixed(0)}s`);
  console.log(
    `    Subagents triggered: ${totalSpawns > 0 ? "YES" : "NO — Codex handled as single agent"}`,
  );

  if (totalSpawns === 0) {
    console.log(`\n  NOTE: Codex did not spawn subagents. This can happen if:`);
    console.log(`    - The Codex version does not support experimentalApi`);
    console.log(`    - The model decided single-agent execution was sufficient`);
    console.log(`    - collaborationMode was not properly received`);
    console.log(`    The test still captured event routing patterns for comparison.`);
  }

  const output = {
    test: "real-subagent",
    runtime: RUNTIME,
    startedAt,
    completedAt,
    duration_ms: completedAt - startedAt,
    config: {
      sessions: allStats.length,
      experimentalApi: true,
      collaborationMode: "plan",
      maxDuration_ms: TEST_DURATION_MS,
    },
    sessions: allStats.map((s) => ({
      ...s,
      events: s.events, // Keep full event timeline
    })),
    timeSeries,
    summary: {
      sessionCount: allStats.length,
      completed: totalCompleted,
      totalEvents,
      totalSubagentSpawns: totalSpawns,
      totalSubagentCompletions: totalCompletions,
      totalInteractionBegins: allStats.reduce((s, st) => s + st.interactionBegins, 0),
      totalInteractionEnds: allStats.reduce((s, st) => s + st.interactionEnds, 0),
      totalCollabWaiting: allStats.reduce((s, st) => s + st.collabWaiting, 0),
      totalToolCalls: allStats.reduce((s, st) => s + st.toolCalls, 0),
      totalDeltasReceived: allStats.reduce((s, st) => s + st.deltasReceived, 0),
      subagentsTriggered: totalSpawns > 0,
      ...(RUNTIME === "node" && lags.length > 0
        ? {
            lagP50_ms:
              Math.round(([...lags].sort((a, b) => a - b)[Math.floor(lags.length * 0.5)] ?? 0) * 10) / 10,
            lagP99_ms:
              Math.round(([...lags].sort((a, b) => a - b)[Math.floor(lags.length * 0.99)] ?? 0) * 10) / 10,
          }
        : {}),
    },
  };

  const filename = `${RUNTIME}-real-subagent-${Date.now()}.json`;
  writeFileSync(`${OUTPUT_DIR}/${filename}`, JSON.stringify(output, null, 2));
  log(`Results written to ${OUTPUT_DIR}/${filename}`);
  console.log("═".repeat(70));

  setTimeout(() => process.exit(0), 3000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
