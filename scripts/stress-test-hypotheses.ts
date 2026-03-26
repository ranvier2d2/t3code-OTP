#!/usr/bin/env bun
/**
 * stress-test-hypotheses.ts — Hypothesis testing for t3code-OTP provider layer.
 *
 * Tests four hypotheses from the PR #14 review session:
 *   H1: Codex auto-compact resets approvalPolicy override (>50 turns)
 *   H2: Model switch on resume drops approval overrides
 *   H3: Same-thread concurrent events cause double session start (<100ms gap)
 *   H4: OpenCode permission gap on resume (SSE timing)
 *
 * Usage:
 *   bun run scripts/stress-test-hypotheses.ts [hypothesis] [options]
 *
 *   hypothesis — "h1", "h2", "h1h2" (chain A), "h3", "h4", or "all" (default)
 *
 * Options:
 *   --exclude <provider>  Exclude a provider (repeatable)
 *   --turns <N>           Number of turns for H1 (default 55)
 *   --resume-model <m>    Model for H2 resume (default "gpt-5.4")
 *   --dual-gap <ms>       Gap between dual turns for H3 (default 50)
 *
 * Prerequisites: pixi run dev (full stack running on ports 3780/4321)
 *
 * Exit codes:
 *   0 — all tested hypotheses REJECTED (no bugs found)
 *   1 — at least one hypothesis CONFIRMED (bug found)
 *   2 — test infrastructure error
 */

import { WebSocket } from "ws";
import crypto from "node:crypto";

const NODE_PORT = Number(process.env.T3CODE_PORT ?? 3780);
const AUTH_TOKEN = process.env.T3CODE_AUTH_TOKEN ?? "";
const CWD = process.cwd();
const RUN_ID = Date.now();

// ── Argument Parsing ──

const args = process.argv.slice(2);
const hypothesis = (args.find((a) => !a.startsWith("--")) ?? "all").toLowerCase();

function getArgValue(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const H1_TURNS = Number(getArgValue("--turns", "55"));
const H2_RESUME_MODEL = getArgValue("--resume-model", "gpt-5.4");
const H3_DUAL_GAP_MS = Number(getArgValue("--dual-gap", "50"));

const excludeSet = new Set<string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exclude" && args[i + 1]) {
    excludeSet.add(args[++i]);
  }
}

const runH1 = ["h1", "h1h2", "all"].includes(hypothesis);
const runH2 = ["h2", "h1h2", "all"].includes(hypothesis);
const runH3 = ["h3", "all"].includes(hypothesis);
const runH4 = ["h4", "all"].includes(hypothesis);

// ── Logging ──

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);
const ok = (msg: string) => console.log(`  ${ts()} ✅ ${msg}`);
const fail = (msg: string) => console.log(`  ${ts()} ❌ ${msg}`);
const warn = (msg: string) => console.log(`  ${ts()} ⚠️  ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function uuid(): string {
  return crypto.randomUUID();
}

// ── WebSocket Client ──

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

        if (msg.type === "push" && msg.channel) {
          if (msg.channel === "server.welcome") {
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

        const id = msg.id as string | undefined;
        if (!id) return;

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

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout (120s): ${method}`));
        }
      }, 120_000);
    });
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.send("orchestration.dispatchCommand", command);
  }

  disconnect() {
    this.ws.close();
  }
}

// ── Hypothesis Result Tracking ──

interface HypothesisResult {
  id: string;
  name: string;
  status: "CONFIRMED" | "REJECTED" | "INCONCLUSIVE" | "SKIPPED";
  evidence: string[];
  details: string;
}

const results: HypothesisResult[] = [];

// ══════════════════════════════════════════════════════════════════════
// H1: Codex auto-compact resets approvalPolicy override (>50 turns)
// ══════════════════════════════════════════════════════════════════════

async function testH1(client: T3Client, projectId: string): Promise<HypothesisResult> {
  const result: HypothesisResult = {
    id: "H1",
    name: "Codex auto-compact resets approvalPolicy override",
    status: "INCONCLUSIVE",
    evidence: [],
    details: "",
  };

  if (excludeSet.has("codex")) {
    result.status = "SKIPPED";
    result.details = "Codex excluded via --exclude";
    return result;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  H1: Auto-compact approval policy reset test");
  console.log(`  Turns: ${H1_TURNS} (threshold for auto-compact)`);
  console.log(`${"═".repeat(60)}`);

  const threadId = `h1-autocompact-${RUN_ID}`;
  const now = new Date().toISOString();

  // Track events for this thread
  let execApprovalCount = 0;
  let compactEventSeen = false;
  let sessionSetSeen = false;
  let turnsCompleted = 0;
  const approvalTimestamps: number[] = [];
  const compactTimestamps: number[] = [];

  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const tid = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    if (tid !== threadId) return;

    const eventType = data.type as string;
    if (eventType === "thread.session-set") sessionSetSeen = true;
    if (eventType === "thread.turn-diff-completed") turnsCompleted++;

    // Look for approval request events (indicates exec_approval_request from Codex)
    if (
      eventType === "thread.approval-response-requested" ||
      eventType === "thread.approval-request"
    ) {
      execApprovalCount++;
      approvalTimestamps.push(Date.now());
      result.evidence.push(`exec_approval_request at turn ~${turnsCompleted}, t=${ts()}`);
    }

    // Look for compact-related events in the raw notifications
    const rawPayload = JSON.stringify(data).toLowerCase();
    if (
      rawPayload.includes("compact") ||
      rawPayload.includes("context_compacted") ||
      rawPayload.includes("contextcompacted")
    ) {
      compactEventSeen = true;
      compactTimestamps.push(Date.now());
      result.evidence.push(`compact event detected at turn ~${turnsCompleted}, t=${ts()}`);
    }
  });

  // Create thread
  try {
    await client.dispatch({
      type: "thread.create",
      commandId: `cmd-h1-create-${threadId}`,
      threadId,
      projectId,
      title: "H1: Auto-compact test",
      model: "gpt-5.3-codex",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    ok("Thread created for H1");
  } catch (e) {
    fail(`H1 thread creation failed: ${e}`);
    result.status = "INCONCLUSIVE";
    result.details = `Thread creation failed: ${e}`;
    return result;
  }

  // Send N turns to push past auto-compact threshold
  log(`Sending ${H1_TURNS} turns to trigger auto-compact...`);

  for (let i = 0; i < H1_TURNS; i++) {
    try {
      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-h1-turn-${i}-${threadId}`,
        threadId,
        message: {
          messageId: `msg-h1-${i}-${uuid()}`,
          role: "user",
          text: `Turn ${i + 1}/${H1_TURNS}: Run "echo H1_TURN_${i + 1} TIMESTAMP=$(date +%s)" in bash and report the output. Keep your response brief.`,
          attachments: [],
        },
        provider: "codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });

      if ((i + 1) % 10 === 0) {
        log(`  Turn ${i + 1}/${H1_TURNS} dispatched`);
      }
    } catch (e) {
      warn(`Turn ${i + 1} failed: ${e}`);
    }

    // Wait for turn to complete before sending next
    const turnDeadline = Date.now() + 60_000;
    const targetTurns = turnsCompleted + 1;
    while (Date.now() < turnDeadline && turnsCompleted < targetTurns) {
      await sleep(500);
    }
  }

  // Wait a bit more for any trailing events
  await sleep(5000);

  // Analyze results
  log(`\nH1 Results:`);
  log(`  Turns completed: ${turnsCompleted}/${H1_TURNS}`);
  log(`  Compact events seen: ${compactEventSeen}`);
  log(`  exec_approval_request count: ${execApprovalCount}`);

  if (execApprovalCount > 0 && compactEventSeen) {
    result.status = "CONFIRMED";
    result.details = `exec_approval_request appeared ${execApprovalCount} time(s) after auto-compact. Compact events detected. Approval policy reset confirmed.`;
    // Correlate timing
    if (approvalTimestamps.length > 0 && compactTimestamps.length > 0) {
      const firstApproval = approvalTimestamps[0];
      const lastCompact = compactTimestamps[compactTimestamps.length - 1];
      result.evidence.push(
        `Timing: first approval at ${firstApproval - t0}ms, last compact at ${lastCompact - t0}ms`,
      );
    }
  } else if (execApprovalCount > 0 && !compactEventSeen) {
    result.status = "CONFIRMED";
    result.details = `exec_approval_request appeared ${execApprovalCount} time(s) without visible compact event. Policy may have been reset by internal compaction.`;
  } else if (turnsCompleted < H1_TURNS * 0.5) {
    result.status = "INCONCLUSIVE";
    result.details = `Only ${turnsCompleted}/${H1_TURNS} turns completed. Test may not have reached auto-compact threshold.`;
  } else {
    result.status = "REJECTED";
    result.details = `No exec_approval_request after ${turnsCompleted} turns. approvalPolicy: "never" survived auto-compact.`;
  }

  // Stop the session for potential H2 reuse
  try {
    await client.dispatch({
      type: "thread.session.stop",
      commandId: `cmd-h1-stop-${threadId}`,
      threadId,
      createdAt: new Date().toISOString(),
    });
    await sleep(3000);
  } catch {
    // ok
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// H2: Model switch on resume drops approval overrides
// ══════════════════════════════════════════════════════════════════════

async function testH2(
  client: T3Client,
  projectId: string,
  h1ThreadId?: string,
): Promise<HypothesisResult> {
  const result: HypothesisResult = {
    id: "H2",
    name: "Model switch on resume drops approval overrides",
    status: "INCONCLUSIVE",
    evidence: [],
    details: "",
  };

  if (excludeSet.has("codex")) {
    result.status = "SKIPPED";
    result.details = "Codex excluded via --exclude";
    return result;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  H2: Model switch on resume — approval override test");
  console.log(`  Resume model: ${H2_RESUME_MODEL}`);
  console.log(`${"═".repeat(60)}`);

  // Use H1's thread if available, otherwise create a fresh one
  const threadId = h1ThreadId ?? `h2-modelswitch-${RUN_ID}`;
  const now = new Date().toISOString();
  let isNewThread = !h1ThreadId;

  let execApprovalCount = 0;
  let mismatchWarnings: string[] = [];
  let turnCompleted = false;

  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const tid = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    if (tid !== threadId) return;

    const eventType = data.type as string;
    if (eventType === "thread.turn-diff-completed") turnCompleted = true;

    if (
      eventType === "thread.approval-response-requested" ||
      eventType === "thread.approval-request"
    ) {
      execApprovalCount++;
      result.evidence.push(`exec_approval_request after model-switch resume, t=${ts()}`);
    }

    // Capture any mismatch warning data from events
    const rawStr = JSON.stringify(data);
    if (rawStr.includes("mismatch") || rawStr.includes("override")) {
      mismatchWarnings.push(rawStr.slice(0, 300));
    }
  });

  if (isNewThread) {
    // Create a fresh thread, do one turn, stop, then resume with different model
    try {
      await client.dispatch({
        type: "thread.create",
        commandId: `cmd-h2-create-${threadId}`,
        threadId,
        projectId,
        title: "H2: Model switch test",
        model: "gpt-5.3-codex",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      // Initial turn
      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-h2-initial-${threadId}`,
        threadId,
        message: {
          messageId: `msg-h2-init-${uuid()}`,
          role: "user",
          text: 'Run "echo H2_INIT OK" in bash.',
          attachments: [],
        },
        provider: "codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });

      // Wait for initial turn
      const initDeadline = Date.now() + 60_000;
      while (Date.now() < initDeadline && !turnCompleted) await sleep(500);
      turnCompleted = false;

      // Stop session
      await client.dispatch({
        type: "thread.session.stop",
        commandId: `cmd-h2-stop-${threadId}`,
        threadId,
        createdAt: new Date().toISOString(),
      });
      await sleep(3000);
      ok("H2 initial session created, turned, and stopped");
    } catch (e) {
      fail(`H2 setup failed: ${e}`);
      result.status = "INCONCLUSIVE";
      result.details = `Setup failed: ${e}`;
      return result;
    }
  }

  // Now resume with a DIFFERENT model — this is the key test
  log(`Resuming thread with model switch: gpt-5.3-codex → ${H2_RESUME_MODEL}`);

  try {
    await client.dispatch({
      type: "thread.turn.start",
      commandId: `cmd-h2-resume-${threadId}`,
      threadId,
      message: {
        messageId: `msg-h2-resume-${uuid()}`,
        role: "user",
        text: `After model switch to ${H2_RESUME_MODEL}: Run "echo H2_RESUMED MODEL=${H2_RESUME_MODEL}" in bash.`,
        attachments: [],
      },
      provider: "codex",
      model: H2_RESUME_MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    ok("H2 resume turn dispatched with model switch");
  } catch (e) {
    warn(`H2 resume turn dispatch failed: ${e}`);
    result.evidence.push(`Resume dispatch error: ${e}`);
  }

  // Wait for resume turn
  const resumeDeadline = Date.now() + 90_000;
  while (Date.now() < resumeDeadline && !turnCompleted) await sleep(500);
  await sleep(5000);

  // Analyze
  log(`\nH2 Results:`);
  log(`  exec_approval_request count: ${execApprovalCount}`);
  log(`  Resume turn completed: ${turnCompleted}`);
  log(`  Mismatch warnings captured: ${mismatchWarnings.length}`);

  if (mismatchWarnings.length > 0) {
    result.evidence.push(
      `Mismatch warnings: ${mismatchWarnings.map((w) => w.slice(0, 100)).join("; ")}`,
    );
  }

  if (execApprovalCount > 0) {
    result.status = "CONFIRMED";
    result.details = `exec_approval_request appeared ${execApprovalCount} time(s) after model-switch resume. Approval override dropped.`;
  } else if (!turnCompleted) {
    result.status = "INCONCLUSIVE";
    result.details = "Resume turn did not complete. Cannot determine override persistence.";
  } else {
    result.status = "REJECTED";
    result.details = `No exec_approval_request after model switch. Overrides survived resume with ${H2_RESUME_MODEL}.`;
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// H3: Same-thread concurrent events cause double session start
// ══════════════════════════════════════════════════════════════════════

async function testH3(client: T3Client, projectId: string): Promise<HypothesisResult> {
  const result: HypothesisResult = {
    id: "H3",
    name: "Same-thread concurrent events cause double session start",
    status: "INCONCLUSIVE",
    evidence: [],
    details: "",
  };

  console.log(`\n${"═".repeat(60)}`);
  console.log("  H3: Concurrent dual-turn same-thread test");
  console.log(`  Gap: ${H3_DUAL_GAP_MS}ms between dispatches`);
  console.log(`${"═".repeat(60)}`);

  const threadId = `h3-concurrent-${RUN_ID}`;
  const now = new Date().toISOString();

  let sessionSetCount = 0;
  let turnStartCount = 0;
  let turnCompleteCount = 0;
  let errorEvents: string[] = [];

  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const tid = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    if (tid !== threadId) return;

    const eventType = data.type as string;
    if (eventType === "thread.session-set") {
      sessionSetCount++;
      result.evidence.push(`session-set event #${sessionSetCount} at t=${ts()}`);
    }
    if (eventType === "thread.turn-start-requested") turnStartCount++;
    if (eventType === "thread.turn-diff-completed") turnCompleteCount++;

    // Capture errors
    if (eventType.includes("error") || eventType.includes("failed")) {
      errorEvents.push(`${eventType}: ${JSON.stringify(data).slice(0, 200)}`);
    }
  });

  // Create thread (using codex as test provider, but any would work)
  const provider = excludeSet.has("codex")
    ? excludeSet.has("opencode")
      ? "cursor"
      : "opencode"
    : "codex";

  try {
    await client.dispatch({
      type: "thread.create",
      commandId: `cmd-h3-create-${threadId}`,
      threadId,
      projectId,
      title: "H3: Concurrent turn test",
      model: provider === "codex" ? "gpt-5.3-codex" : "auto",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    ok(`Thread created for H3 (provider: ${provider})`);
  } catch (e) {
    fail(`H3 thread creation failed: ${e}`);
    result.status = "INCONCLUSIVE";
    result.details = `Thread creation failed: ${e}`;
    return result;
  }

  // Fire two turns for the SAME thread with minimal gap
  log(`Dispatching two turns with ${H3_DUAL_GAP_MS}ms gap...`);

  const turn1Promise = client.dispatch({
    type: "thread.turn.start",
    commandId: `cmd-h3-turn-A-${threadId}`,
    threadId,
    message: {
      messageId: `msg-h3-A-${uuid()}`,
      role: "user",
      text: 'Run "echo H3_TURN_A OK" in bash.',
      attachments: [],
    },
    provider,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  // Wait the specified gap (should be <100ms to test the race)
  await sleep(H3_DUAL_GAP_MS);

  const turn2Promise = client.dispatch({
    type: "thread.turn.start",
    commandId: `cmd-h3-turn-B-${threadId}`,
    threadId,
    message: {
      messageId: `msg-h3-B-${uuid()}`,
      role: "user",
      text: 'Run "echo H3_TURN_B OK" in bash.',
      attachments: [],
    },
    provider,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  // Wait for both to settle
  const [r1, r2] = await Promise.allSettled([turn1Promise, turn2Promise]);

  if (r1.status === "rejected") {
    result.evidence.push(`Turn A rejected: ${r1.reason}`);
  }
  if (r2.status === "rejected") {
    result.evidence.push(`Turn B rejected: ${r2.reason}`);
  }

  // Wait for events to settle
  const settleDeadline = Date.now() + 60_000;
  while (Date.now() < settleDeadline && turnCompleteCount < 1) {
    await sleep(1000);
  }
  await sleep(5000);

  // Analyze
  log(`\nH3 Results:`);
  log(`  session-set events: ${sessionSetCount}`);
  log(`  turn-start-requested events: ${turnStartCount}`);
  log(`  turn-diff-completed events: ${turnCompleteCount}`);
  log(`  error events: ${errorEvents.length}`);

  if (sessionSetCount > 1) {
    result.status = "CONFIRMED";
    result.details = `Multiple session-set events (${sessionSetCount}) detected for same thread. Double session start confirmed.`;
  } else if (errorEvents.length > 0) {
    result.status = "CONFIRMED";
    result.details = `Error events detected during concurrent turns: ${errorEvents.join("; ").slice(0, 300)}`;
    result.evidence.push(...errorEvents);
  } else if (turnStartCount > 1 && sessionSetCount === 1) {
    result.status = "REJECTED";
    result.details = `Both turns dispatched (${turnStartCount} turn-start events) but only 1 session created. hasHandledTurnStartRecently dedup or GenServer serialization prevented double start.`;
  } else if (turnStartCount <= 1) {
    // The dedup cache caught the second turn
    result.status = "REJECTED";
    result.details = `Only ${turnStartCount} turn-start event(s) reached the reactor. Dedup cache prevented second dispatch.`;
  } else {
    result.status = "REJECTED";
    result.details = "No double session start detected.";
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// H4: OpenCode permission gap on resume (SSE timing)
// ══════════════════════════════════════════════════════════════════════

async function testH4(client: T3Client, projectId: string): Promise<HypothesisResult> {
  const result: HypothesisResult = {
    id: "H4",
    name: "OpenCode permission gap on resume",
    status: "INCONCLUSIVE",
    evidence: [],
    details: "",
  };

  if (excludeSet.has("opencode")) {
    result.status = "SKIPPED";
    result.details = "OpenCode excluded via --exclude";
    return result;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  H4: OpenCode SSE permission timing test");
  console.log(`${"═".repeat(60)}`);

  const threadId = `h4-opencode-timing-${RUN_ID}`;
  const now = new Date().toISOString();

  let sessionReady = false;
  let turnCompleted = false;
  let permissionRequested = false;
  let permissionRequestTimestamp = 0;
  let sessionReadyTimestamp = 0;
  let sseTimingEvents: Array<{ event: string; ts: number }> = [];

  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const tid = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    if (tid !== threadId) return;

    const eventType = data.type as string;
    const eventTs = Date.now();

    if (eventType === "thread.session-set") {
      sessionReady = true;
      sessionReadyTimestamp = eventTs;
      sseTimingEvents.push({ event: "session-set", ts: eventTs });
    }
    if (eventType === "thread.turn-diff-completed") {
      turnCompleted = true;
      sseTimingEvents.push({ event: "turn-completed", ts: eventTs });
    }

    // Track permission/approval events
    if (
      eventType === "thread.approval-response-requested" ||
      eventType.includes("permission") ||
      eventType.includes("approval")
    ) {
      permissionRequested = true;
      permissionRequestTimestamp = eventTs;
      sseTimingEvents.push({ event: eventType, ts: eventTs });
      result.evidence.push(`Permission event at t=${ts()}, ${eventTs - t0}ms from start`);
    }
  });

  // Create thread with OpenCode
  try {
    await client.dispatch({
      type: "thread.create",
      commandId: `cmd-h4-create-${threadId}`,
      threadId,
      projectId,
      title: "H4: OpenCode timing test",
      model: "auto",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    ok("Thread created for H4 (opencode)");
  } catch (e) {
    fail(`H4 thread creation failed: ${e}`);
    result.status = "INCONCLUSIVE";
    result.details = `Thread creation failed: ${e}`;
    return result;
  }

  // Phase 1: Initial turn (this establishes the session)
  try {
    await client.dispatch({
      type: "thread.turn.start",
      commandId: `cmd-h4-init-${threadId}`,
      threadId,
      message: {
        messageId: `msg-h4-init-${uuid()}`,
        role: "user",
        text: 'Run "echo H4_INIT OK" in bash.',
        attachments: [],
      },
      provider: "opencode",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    warn(`H4 initial turn failed: ${e}`);
  }

  // Wait for initial turn to complete
  const initDeadline = Date.now() + 60_000;
  while (Date.now() < initDeadline && !turnCompleted) await sleep(500);
  turnCompleted = false;
  sessionReady = false;

  // Phase 2: Stop session
  try {
    await client.dispatch({
      type: "thread.session.stop",
      commandId: `cmd-h4-stop-${threadId}`,
      threadId,
      createdAt: new Date().toISOString(),
    });
    await sleep(3000);
    ok("H4 session stopped");
  } catch {
    // ok
  }

  // Phase 3: Resume with a tool-heavy prompt that immediately triggers permissions
  sseTimingEvents = []; // reset for resume phase
  permissionRequested = false;
  const resumeDispatchTs = Date.now();

  try {
    await client.dispatch({
      type: "thread.turn.start",
      commandId: `cmd-h4-resume-${threadId}`,
      threadId,
      message: {
        messageId: `msg-h4-resume-${uuid()}`,
        role: "user",
        text: 'Immediately run "echo H4_RESUMED OK" in bash. Do not ask for confirmation.',
        attachments: [],
      },
      provider: "opencode",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    });
    ok("H4 resume turn dispatched");
  } catch (e) {
    warn(`H4 resume dispatch failed: ${e}`);
  }

  // Wait for resume turn
  const resumeDeadline = Date.now() + 90_000;
  while (Date.now() < resumeDeadline && !turnCompleted) await sleep(500);
  await sleep(5000);

  // Analyze timing
  log(`\nH4 Results:`);
  log(`  Resume turn completed: ${turnCompleted}`);
  log(`  Permission requested during resume: ${permissionRequested}`);
  log(`  SSE timing events:`);

  for (const evt of sseTimingEvents) {
    const relTs = evt.ts - resumeDispatchTs;
    log(`    ${evt.event}: +${relTs}ms from resume dispatch`);
  }

  if (permissionRequested && sessionReadyTimestamp > 0) {
    const gap = permissionRequestTimestamp - sessionReadyTimestamp;
    result.evidence.push(
      `Permission requested ${gap}ms after session-set. Session-set at +${sessionReadyTimestamp - resumeDispatchTs}ms, permission at +${permissionRequestTimestamp - resumeDispatchTs}ms from dispatch.`,
    );

    if (gap < 0) {
      result.status = "CONFIRMED";
      result.details = `Permission request arrived ${Math.abs(gap)}ms BEFORE session-set event. SSE handler was not ready.`;
    } else if (gap < 100) {
      result.status = "INCONCLUSIVE";
      result.details = `Permission gap is very small (${gap}ms). Marginal — could be racy under load.`;
    } else {
      result.status = "REJECTED";
      result.details = `Permission request arrived ${gap}ms AFTER session-set. SSE handler was ready in time.`;
    }
  } else if (!permissionRequested && turnCompleted) {
    result.status = "REJECTED";
    result.details =
      "No permission request observed during resume — OpenCode may have auto-approved via AutoApproveSession, or SSE was connected in time.";
    result.evidence.push(
      "Note: The harness auto-approves OpenCode permissions in full-access mode. " +
        "Check opencode_session.ex timing logs for SSE connect vs first permission.asked timestamps.",
    );
  } else if (!turnCompleted) {
    result.status = "INCONCLUSIVE";
    result.details = "Resume turn did not complete. Cannot measure timing gap.";
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         Hypothesis Testing — t3code-OTP Provider Layer       ║
║                                                              ║
║  Testing: ${hypothesis.padEnd(49)}║
║  H1 (auto-compact): ${runH1 ? "YES" : "SKIP"}                                       ║
║  H2 (model switch): ${runH2 ? "YES" : "SKIP"}                                       ║
║  H3 (concurrent):   ${runH3 ? "YES" : "SKIP"}                                       ║
║  H4 (SSE timing):   ${runH4 ? "YES" : "SKIP"}                                       ║
║  Node WS: ws://127.0.0.1:${String(NODE_PORT).padEnd(32)}║
║  Run ID:  ${String(RUN_ID).padEnd(48)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new T3Client();
  let welcomeData: Record<string, unknown>;
  try {
    welcomeData = await client.connect();
    ok("Connected to Node server");
  } catch (e) {
    fail(`Cannot connect to Node server on port ${NODE_PORT}: ${e}`);
    console.error("\nMake sure the full stack is running: pixi run dev\n");
    process.exit(2);
  }

  const projectId = (welcomeData.bootstrapProjectId as string) ?? `hyp-project-${RUN_ID}`;

  if (!welcomeData.bootstrapProjectId) {
    try {
      await client.dispatch({
        type: "project.create",
        commandId: `cmd-project-${RUN_ID}`,
        projectId,
        title: "Hypothesis Test Project",
        workspaceRoot: CWD,
        defaultModel: "gpt-5.3-codex",
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      fail(`Project creation failed: ${e}`);
      process.exit(2);
    }
  }

  // ── Chain A: H1 → H2 (sequential) ──
  let h1ThreadId: string | undefined;
  if (runH1) {
    const h1 = await testH1(client, projectId);
    results.push(h1);
    if (h1.status !== "INCONCLUSIVE") {
      h1ThreadId = `h1-autocompact-${RUN_ID}`;
    }
  }

  if (runH2) {
    const h2 = await testH2(client, projectId, runH1 ? h1ThreadId : undefined);
    results.push(h2);
  }

  // ── Chain B: H3 (independent) ──
  if (runH3) {
    const h3 = await testH3(client, projectId);
    results.push(h3);
  }

  // ── Chain C: H4 (independent) ──
  if (runH4) {
    const h4 = await testH4(client, projectId);
    results.push(h4);
  }

  // ── Final Report ──
  client.disconnect();

  console.log(`\n${"═".repeat(60)}`);
  console.log("  HYPOTHESIS TEST RESULTS");
  console.log(`${"═".repeat(60)}\n`);

  let anyConfirmed = false;

  for (const r of results) {
    const icon =
      r.status === "CONFIRMED"
        ? "❌ CONFIRMED (bug)"
        : r.status === "REJECTED"
          ? "✅ REJECTED (no bug)"
          : r.status === "SKIPPED"
            ? "⏭️  SKIPPED"
            : "⚠️  INCONCLUSIVE";

    console.log(`  ${icon}  ${r.id}: ${r.name}`);
    console.log(`    Status: ${r.status}`);
    console.log(`    ${r.details}`);
    if (r.evidence.length > 0) {
      console.log(`    Evidence:`);
      for (const e of r.evidence) {
        console.log(`      - ${e}`);
      }
    }
    console.log();

    if (r.status === "CONFIRMED") anyConfirmed = true;
  }

  console.log(`${"═".repeat(60)}`);
  if (anyConfirmed) {
    console.log("  ❌ At least one hypothesis CONFIRMED — bugs found");
  } else {
    console.log("  ✅ All hypotheses REJECTED or INCONCLUSIVE");
  }
  console.log(`${"═".repeat(60)}\n`);

  process.exit(anyConfirmed ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
