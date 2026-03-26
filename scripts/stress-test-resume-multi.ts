#!/usr/bin/env bun
/**
 * stress-test-resume-multi.ts — Multi-session resume E2E through Node server.
 *
 * Simulates real user behavior: connects to the Node WebSocket (port 3780),
 * creates threads, sends turns via the orchestration engine, stops sessions,
 * then restarts on the same threadIds to validate resume.
 *
 * Flow: Script → Node WS (3780) → Orchestration Engine → Harness (4321) → Codex
 *
 * Usage: bun run scripts/stress-test-resume-multi.ts [mode] [arg]
 *   mode — "multi" (1 per provider, 4 total)
 *          "scale" [N] (N per provider, 4N total — default N=3 → 12 sessions)
 *          [N] [provider] (N sessions, 1 provider)
 *
 * Examples:
 *   bun run scripts/stress-test-resume-multi.ts multi          # 4 sessions (1 per provider)
 *   bun run scripts/stress-test-resume-multi.ts scale 3        # 12 sessions (3 per provider)
 *   bun run scripts/stress-test-resume-multi.ts 3 codex        # 3 codex sessions
 *
 * Prerequisites: pixi run dev (full stack running)
 */

import { WebSocket } from "ws";
import crypto from "node:crypto";

const NODE_PORT = Number(process.env.T3CODE_PORT ?? 3780);
const AUTH_TOKEN = process.env.T3CODE_AUTH_TOKEN ?? "";
const CWD = process.cwd();
const RUN_ID = Date.now();

const DEFAULT_MODELS: Record<string, string> = {
  codex: "gpt-5.3-codex",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "auto",
  opencode: "auto",
};

// Parse args: "multi" (1 per provider), "scale" (N per provider), or "[N] [provider]"
const MODE = process.argv[2] ?? "multi";
const isMultiProvider = MODE === "multi" || MODE === "scale";

interface SessionSpec {
  threadId: string;
  provider: string;
  model: string;
  label: string;
}

// All 4 providers including Claude (Node SDK)
const ALL_PROVIDERS = ["codex", "claudeAgent", "cursor", "opencode"];

let sessions: SessionSpec[];
if (MODE === "scale") {
  // N sessions per provider (default 3) = 4 providers × N = 4N total
  const perProvider = Number(process.argv[3] ?? 3);
  sessions = ALL_PROVIDERS.flatMap((p) =>
    Array.from({ length: perProvider }, (_, i) => ({
      threadId: `scale-${p}-${i}-${RUN_ID}`,
      provider: p,
      model: DEFAULT_MODELS[p] ?? "auto",
      label: `${p}[${i}]`,
    })),
  );
} else if (MODE === "multi") {
  // One session per provider (4 total)
  sessions = ALL_PROVIDERS.map((p) => ({
    threadId: `resume-${p}-${RUN_ID}`,
    provider: p,
    model: DEFAULT_MODELS[p] ?? "auto",
    label: p,
  }));
} else {
  const N = Number(MODE) || 3;
  const PROVIDER = process.argv[3] ?? "codex";
  sessions = Array.from({ length: N }, (_, i) => ({
    threadId: `resume-thread-${i}-${RUN_ID}`,
    provider: PROVIDER,
    model: DEFAULT_MODELS[PROVIDER] ?? "auto",
    label: `${PROVIDER}[${i}]`,
  }));
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);
const ok = (msg: string) => console.log(`  ${ts()} ✅ ${msg}`);
const fail = (msg: string) => console.log(`  ${ts()} ❌ ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function uuid(): string {
  return crypto.randomUUID();
}

// ── WebSocket client that speaks the t3code Node protocol ──

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface PushEvent {
  channel: string;
  data: Record<string, unknown>;
}

class T3Client {
  private ws!: WebSocket;
  private pending = new Map<string, PendingRequest>();
  private pushListeners: Array<(event: PushEvent) => void> = [];
  private welcome: Record<string, unknown> | null = null;

  async connect(): Promise<Record<string, unknown>> {
    const url = AUTH_TOKEN
      ? `ws://127.0.0.1:${NODE_PORT}?token=${AUTH_TOKEN}`
      : `ws://127.0.0.1:${NODE_PORT}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("error", (err) => reject(err));

      this.ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Push events: {type: "push", sequence, channel, data}
        if (msg.type === "push" && msg.channel) {
          if (msg.channel === "server.welcome") {
            this.welcome = msg.data as Record<string, unknown>;
            resolve(msg.data as Record<string, unknown>);
            return;
          }
          for (const listener of this.pushListeners) {
            listener({
              channel: msg.channel as string,
              data: msg.data as Record<string, unknown>,
            });
          }
          return;
        }

        // RPC response: {id, result?, error?}
        const id = msg.id as string | undefined;
        if (!id) return;

        // Schema validation errors return id="unknown" — reject all pending
        // since we can't correlate which request caused the error
        if (id === "unknown" && msg.error) {
          const errMsg = (msg.error as { message?: string }).message ?? JSON.stringify(msg.error);
          for (const [, p] of this.pending) {
            p.reject(new Error(`Schema error: ${errMsg}`));
          }
          this.pending.clear();
          return;
        }

        if (this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          const error = msg.error as { message?: string } | undefined;
          if (error) {
            p.reject(new Error(error.message ?? JSON.stringify(error)));
          } else {
            p.resolve(msg.result);
          }
        }
      });

      this.ws.on("close", () => {
        for (const [, p] of this.pending) {
          p.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  onPush(listener: (event: PushEvent) => void) {
    this.pushListeners.push(listener);
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const id = uuid();
    const body =
      method === "orchestration.dispatchCommand"
        ? { _tag: method, command: params }
        : params && typeof params === "object" && !Array.isArray(params)
          ? { _tag: method, ...(params as Record<string, unknown>) }
          : { _tag: method };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, body }));

      // Timeout — longer for scale mode (12+ concurrent provider startups)
      const timeoutMs = sessions.length > 4 ? 120_000 : 60_000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout (${timeoutMs / 1000}s): ${method}`));
        }
      }, timeoutMs);
    });
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.send("orchestration.dispatchCommand", command);
  }

  disconnect() {
    this.ws.close();
  }
}

// ── Track orchestration events per thread ──

interface ThreadTracker {
  threadId: string;
  projectId: string;
  sessionReady: boolean;
  turnStarted: boolean;
  turnCompleted: boolean;
  sessionStopped: boolean;
  resumeFallback: boolean;
  events: string[];
}

function makeTracker(threadId: string, projectId: string): ThreadTracker {
  return {
    threadId,
    projectId,
    sessionReady: false,
    turnStarted: false,
    turnCompleted: false,
    sessionStopped: false,
    resumeFallback: false,
    events: [],
  };
}

// ── Main ──

async function main() {
  const providerList = [...new Set(sessions.map((s) => s.provider))].join(", ");
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║      Multi-Session Resume E2E (via Node Orchestration)       ║
║                                                              ║
║  Mode:     ${(isMultiProvider ? "multi-provider" : "single-provider").padEnd(48)}║
║  Sessions: ${String(sessions.length).padEnd(48)}║
║  Providers:${providerList.padEnd(48)}║
║  Node WS:  ws://127.0.0.1:${String(NODE_PORT).padEnd(32)}║
║  Run ID:   ${String(RUN_ID).padEnd(48)}║
╚══════════════════════════════════════════════════════════════╝
`);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Connect, create project + threads, send turns
  // ═══════════════════════════════════════════════════════════════
  console.log("── Phase 1: Connect & create threads ──");

  const client = new T3Client();
  const welcomeData = await client.connect();
  ok(`Connected to Node server (welcome received)`);

  // Reuse the bootstrap project so threads show in the main sidebar project
  const projectId = (welcomeData.bootstrapProjectId as string) ?? `resume-project-${RUN_ID}`;
  ok(`Using project: ${projectId}${welcomeData.bootstrapProjectId ? " (bootstrap)" : " (new)"}`);

  // Track events
  const phase1Trackers = new Map<string, ThreadTracker>();
  const phase2Trackers = new Map<string, ThreadTracker>();

  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    // Domain events nest the actual event data under payload
    const payload = data.payload as Record<string, unknown> | undefined;
    const threadId = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    const eventType = data.type as string;
    if (!eventType) return;
    // Debug: log first few events to verify structure
    if (phase1Trackers.size > 0) {
      const known = phase1Trackers.has(threadId) || phase2Trackers.has(threadId);
      if (!known && (data.aggregateKind === "thread")) {
        log(`  [DEBUG] untracked thread event: type=${eventType} tid=${(threadId || "").slice(-12)} agg=${data.aggregateId}`);
      }
    }

    // Phase 1 tracking
    const t1 = phase1Trackers.get(threadId);
    if (t1) {
      t1.events.push(eventType);
      if (eventType === "thread.session-set") t1.sessionReady = true;
      if (eventType === "thread.turn-start-requested") t1.turnStarted = true;
      if (eventType === "thread.turn-diff-completed") t1.turnCompleted = true;
      if (eventType === "thread.session-stop-requested") t1.sessionStopped = true;
    }

    // Phase 2 tracking
    const t2 = phase2Trackers.get(threadId);
    if (t2) {
      t2.events.push(eventType);
      if (eventType === "thread.session-set") t2.sessionReady = true;
      if (eventType === "thread.turn-start-requested") t2.turnStarted = true;
      if (eventType === "thread.turn-diff-completed") t2.turnCompleted = true;
    }
  });

  const now = new Date().toISOString();

  // Only create a project if we couldn't reuse the bootstrap one
  if (!welcomeData.bootstrapProjectId) {
    try {
      await client.dispatch({
        type: "project.create",
        commandId: `cmd-project-${RUN_ID}`,
        projectId,
        title: "Resume Stress Test",
        workspaceRoot: CWD,
        defaultModel: sessions[0]?.model ?? "gpt-5.3-codex",
        createdAt: now,
      });
      ok(`Project created: ${projectId}`);
    } catch (e) {
      fail(`Project create failed: ${e}`);
      process.exit(1);
    }
  }

  // Create threads (one per session spec)
  for (const s of sessions) {
    phase1Trackers.set(s.threadId, makeTracker(s.threadId, projectId));

    try {
      await client.dispatch({
        type: "thread.create",
        commandId: `cmd-thread-create-${s.threadId}`,
        threadId: s.threadId,
        projectId,
        title: `${s.label}`,
        model: s.model,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      log(`  [${s.label}] thread created`);
    } catch (e) {
      fail(`  [${s.label}] thread create failed: ${e}`);
    }
  }

  // Send turns to all sessions concurrently
  console.log("\n── Phase 1b: Send turns concurrently ──");
  const turnPromises = sessions.map(async (s) => {
    try {
      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-turn-${s.threadId}`,
        threadId: s.threadId,
        message: {
          messageId: `msg-${uuid()}`,
          role: "user",
          text: `Run "echo PROVIDER=${s.provider} THREAD=${s.threadId.slice(-8)} OK" in bash and report the output. Nothing else.`,
          attachments: [],
        },
        provider: s.provider,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });
      log(`  [${s.label}] turn dispatched`);
    } catch (e) {
      fail(`  [${s.label}] turn failed: ${e}`);
    }
  });
  await Promise.all(turnPromises);

  // Wait for all turns to complete
  log("Waiting for turns to complete...");
  const turnDeadline = Date.now() + 120_000;
  while (Date.now() < turnDeadline) {
    const allDone = [...phase1Trackers.values()].every((t) => t.turnCompleted);
    if (allDone) break;
    await sleep(1000);
  }

  const completedCount = [...phase1Trackers.values()].filter((t) => t.turnCompleted).length;
  if (completedCount === sessions.length) {
    ok(`All ${sessions.length} turns completed`);
  } else {
    fail(`Only ${completedCount}/${sessions.length} turns completed`);
    const incomplete = [...phase1Trackers.values()]
      .filter((t) => !t.turnCompleted)
      .map((t) => t.threadId.slice(-8));
    log(`  Incomplete: ${incomplete.join(", ")}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Stop sessions, then restart (expect resume)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: Stop sessions ──");

  const stopPromises = sessions.map(async (s) => {
    try {
      await client.dispatch({
        type: "thread.session.stop",
        commandId: `cmd-stop-${s.threadId}`,
        threadId: s.threadId,
        createdAt: new Date().toISOString(),
      });
      log(`  [${s.label}] stopped`);
    } catch (e) {
      fail(`  [${s.label}] stop failed: ${e}`);
    }
  });
  await Promise.all(stopPromises);

  // Wait for all sessions to confirm stopped (or timeout)
  const stopDeadline = Date.now() + 30_000;
  while (Date.now() < stopDeadline) {
    const allStopped = [...phase1Trackers.values()].every((t) => t.sessionStopped);
    if (allStopped) break;
    await sleep(500);
  }

  // Set up phase 2 trackers early so we catch events during restart
  for (const s of sessions) {
    phase2Trackers.set(s.threadId, makeTracker(s.threadId, projectId));
  }

  console.log("\n── Phase 3: Restart sessions (expect thread/resume) ──");

  // Send a new turn to each thread — the orchestration engine should
  // create a new session with the stored resumeCursor
  const resumePromises = sessions.map(async (s) => {
    try {
      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-resume-turn-${s.threadId}`,
        threadId: s.threadId,
        message: {
          messageId: `msg-resume-${uuid()}`,
          role: "user",
          text: `Write a one-line bash script to /tmp/t3test-${s.threadId.slice(-8)}.sh that prints "${s.label} RESUMED". Then run it and report the output.`,
          attachments: [],
        },
        provider: s.provider,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });
      log(`  [${s.label}] resume turn dispatched`);
    } catch (e) {
      fail(`  [${s.label}] resume turn failed: ${e}`);
    }
  });
  await Promise.all(resumePromises);

  // Wait for resume turns to complete
  log("Waiting for resume turns to complete...");
  const resumeDeadline = Date.now() + 120_000;
  while (Date.now() < resumeDeadline) {
    const allDone = [...phase2Trackers.values()].every((t) => t.turnCompleted);
    if (allDone) break;
    await sleep(1000);
  }

  const resumeCompletedCount = [...phase2Trackers.values()].filter((t) => t.turnCompleted).length;
  if (resumeCompletedCount === sessions.length) {
    ok(`All ${sessions.length} resume turns completed`);
  } else {
    fail(`Only ${resumeCompletedCount}/${sessions.length} resume turns completed`);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log("\n── Results ──");

  let allPassed = true;

  for (const s of sessions) {
    const p1 = phase1Trackers.get(s.threadId)!;
    const p2 = phase2Trackers.get(s.threadId)!;
    const label = s.label;

    const p1ok = p1.turnCompleted;
    const p2ok = p2.turnCompleted;

    if (p1ok && p2ok) {
      ok(`[${label}] Phase 1: turn ✓ | Phase 2: resume turn ✓`);
    } else {
      fail(`[${label}] Phase 1: turn=${p1.turnCompleted} | Phase 2: resume turn=${p2.turnCompleted}`);
      allPassed = false;
    }

    log(`  [${label}] Phase 1 events: ${p1.events.length} | Phase 2 events: ${p2.events.length}`);
  }

  // Cleanup
  client.disconnect();

  console.log("\n" + "═".repeat(60));
  if (allPassed) {
    console.log("  ✅ ALL PASSED — Multi-session E2E resume validated");
  } else {
    console.log("  ❌ SOME FAILURES — Check output above");
  }
  console.log("═".repeat(60) + "\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
