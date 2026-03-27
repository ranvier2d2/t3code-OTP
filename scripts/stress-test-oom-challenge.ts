#!/usr/bin/env bun
/**
 * stress-test-oom-challenge.ts — 1-up OOM multi-provider concurrent session ramp.
 *
 * Geometrically scales real provider sessions through the Elixir harness:
 *   Step 1:   4 sessions (1 per provider)
 *   Step 2:  20 sessions (5 per provider)
 *   Step 3: 100 sessions (25 per provider)
 *   Step 4: 200 sessions (50 per provider)
 *
 * Each step adds a proportional mock control group for baseline comparison.
 * All turns require tool usage (bash commands) to exercise the full provider pipeline.
 *
 * Auto-stops when completion rate < 80% or p99 latency > 60s.
 *
 * Usage:
 *   bun run scripts/stress-test-oom-challenge.ts
 *   bun run scripts/stress-test-oom-challenge.ts --steps=4,20
 *   bun run scripts/stress-test-oom-challenge.ts --timeout=180
 *   bun run scripts/stress-test-oom-challenge.ts --no-mock    # skip mock control group
 *   bun run scripts/stress-test-oom-challenge.ts --dry-run    # start sessions but skip turns
 *
 * Prerequisites:
 *   - Elixir harness running on port 4321 (./scripts/dev-harness.sh)
 *   - Real providers available: codex, claudeAgent, cursor, opencode
 */

import {
  HarnessClientManager,
  type HarnessRawEvent,
} from "../apps/server/src/provider/Layers/HarnessClientManager.ts";
import { WebSocket } from "ws";
import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HARNESS_PORT = Number(process.env.T3CODE_HARNESS_PORT ?? 4321);
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const NODE_PORT = Number(process.env.T3CODE_PORT ?? 3780);
const METRICS_URL = `http://127.0.0.1:${HARNESS_PORT}/api/metrics`;
const OUTPUT_DIR = `${process.cwd()}/output/stress-test`;
const CWD = process.cwd();

mkdirSync(OUTPUT_DIR, { recursive: true });

// CLI args
const args = process.argv.slice(2);
const stepsArg = args.find((a) => a.startsWith("--steps="))?.split("=")[1];
const DEFAULT_STEPS = [4, 20, 100, 200];
const STEPS: number[] = stepsArg ? stepsArg.split(",").map(Number) : DEFAULT_STEPS;
const TURN_TIMEOUT_S = Number(args.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? "120");
const SKIP_MOCK = args.includes("--no-mock");
const DRY_RUN = args.includes("--dry-run");
const VISIBLE = args.includes("--visible"); // route through Node WS so sessions appear in browser UI
const COOLDOWN_MS = 10_000;

// Stop conditions — BEAM telemetry-based (not provider latency)
const MIN_COMPLETION_RATE = 0.8;
const MAX_SNAPSHOT_QUEUE = 500; // SnapshotServer message_queue_len sustained
const _MAX_SCHEDULER_UTIL = 0.8; // TODO: sustained scheduler check needs time-series sampling
const MAX_MEMORY_GROWTH_FACTOR = 5; // BEAM memory > 5x step start
const CODEX_DEGRADATION_RATIO = 5; // Codex p50 > 5x its step-1 baseline
const INFRA_ERROR_PATTERNS = [":emfile", ":enomem", ":system_limit", "Erlang error"];

const PROVIDERS = ["codex", "claudeAgent", "cursor", "opencode"] as const;
type Provider = (typeof PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Prompts — lightweight but require tool usage (bash)
// ---------------------------------------------------------------------------

const TOOL_PROMPTS: Record<Provider, string[]> = {
  codex: [
    'Run `echo "codex-$(date +%s)-$RANDOM"` in bash and report the exact output.',
    "Run `ls /tmp | wc -l` in bash and tell me how many files are in /tmp.",
    "Run `uname -srm` in bash and report the output verbatim.",
    "Run `cat /etc/shells | head -3` in bash and report the output.",
    "Execute `echo $((RANDOM % 1000))` in bash. Report the number.",
  ],
  claudeAgent: [
    'Run `echo "claude-$(date +%s)-$RANDOM"` in bash and report the exact output.',
    "Run `whoami && pwd` in bash and report the output verbatim.",
    'Run `env | grep -c ""` in bash. Report the count of environment variables.',
    'Run `date -u +"%Y-%m-%dT%H:%M:%S"` in bash. Report the UTC timestamp.',
    "Execute `wc -l < /etc/hosts` in bash. Report the line count.",
  ],
  cursor: [
    'Run `echo "cursor-$(date +%s)-$RANDOM"` in bash and report the exact output.',
    "Run `ls -1 /usr/bin | head -5` in bash and report the output.",
    "Run `df -h / | tail -1` in bash and report the disk usage.",
    "Run `sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1` in bash. Report the CPU count.",
    'Execute `echo "$SHELL"` in bash. Report which shell is configured.',
  ],
  opencode: [
    'Run `echo "opencode-$(date +%s)-$RANDOM"` in bash and report the exact output.',
    "Run `find /tmp -maxdepth 1 -type f 2>/dev/null | head -3` in bash and list the files.",
    "Run `uptime` in bash and report the output.",
    "Run `ps aux | wc -l` in bash. Report the process count.",
    'Execute `echo "hello" | base64` in bash. Report the base64 output.',
  ],
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`  ${ts()} ${msg}`);
const ok = (msg: string) => console.log(`  ${ts()} ✅ ${msg}`);
const fail = (msg: string) => console.log(`  ${ts()} ❌ ${msg}`);
const warn = (msg: string) => console.log(`  ${ts()} ⚠️  ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSystemMemoryGB(): Promise<number> {
  try {
    const proc = Bun.spawn(["sysctl", "-n", "hw.memsize"], { stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    return Number(text.trim()) / 1024 / 1024 / 1024;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// T3Client — WebSocket client for Node server (visible mode)
// ---------------------------------------------------------------------------

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
    const url = `ws://127.0.0.1:${NODE_PORT}`;
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
            listener({ channel: msg.channel as string, data: msg.data as Record<string, unknown> });
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

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    const body = { _tag: "orchestration.dispatchCommand", command };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, body }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout (120s): dispatchCommand`));
        }
      }, 120_000);
    });
  }

  disconnect() {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Visible mode adapter — wraps T3Client with same tracking as harness-direct
// ---------------------------------------------------------------------------

interface VisibleAdapter {
  client: T3Client;
  projectId: string;
  connect(): Promise<void>;
  startSession(threadId: string, provider: string): Promise<void>;
  sendTurn(threadId: string, prompt: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;
  disconnect(): void;
}

function createVisibleAdapter(sessions: Map<string, SessionState>): VisibleAdapter {
  const client = new T3Client();
  let projectId = "";
  const now = () => new Date().toISOString();

  // Track events from Node WS pushes
  client.onPush((event) => {
    if (event.channel !== "orchestration.domainEvent") return;
    const data = event.data as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const tid = (payload?.threadId ?? data.threadId ?? data.aggregateId) as string;
    const s = sessions.get(tid);
    if (!s) return;

    const eventType = data.type as string;

    if (eventType === "thread.turn-start-requested") {
      s.turnStartedAt = Date.now();
    }

    if (eventType === "thread.message-sent") {
      const msgPayload = payload ?? data;
      if (msgPayload.role === "assistant" || (msgPayload as Record<string, unknown>).streaming) {
        const nowMs = Date.now();
        s.deltasReceived++;
        s.lastDeltaAt = nowMs;
        if (s.firstDeltaAt === null) {
          s.firstDeltaAt = nowMs;
          if (s.turnStartedAt) {
            s.latencies.push(nowMs - s.turnStartedAt);
          }
        }
        const text = String((msgPayload as Record<string, unknown>).text ?? "");
        s.text += text;
      }
    }

    if (eventType === "thread.turn-diff-completed") {
      s.turnsCompleted++;
      s.turnCompletedAt = Date.now();
      s.firstDeltaAt = null;
      s.turnStartedAt = null;
    }

    if (eventType === "thread.activity-appended") {
      const kind = String((payload as Record<string, unknown>)?.kind ?? "");
      if (kind === "error") {
        s.errors.push(String((payload as Record<string, unknown>)?.message ?? "activity error"));
      }
    }
  });

  return {
    client,
    projectId,

    async connect() {
      const welcome = await client.connect();
      projectId = (welcome.bootstrapProjectId as string) ?? "";
      this.projectId = projectId;
      if (!projectId) {
        throw new Error("No bootstrapProjectId in server.welcome — is T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1?");
      }
    },

    async startSession(threadId: string, provider: string) {
      const modelSelection = getModelSelection(provider);
      await client.dispatch({
        type: "thread.create",
        commandId: `cmd-create-${threadId}`,
        threadId,
        projectId,
        title: `OOM ${provider} ${threadId.slice(-8)}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now(),
      });
    },

    async sendTurn(threadId: string, prompt: string) {
      const s = sessions.get(threadId);
      const provider = s?.provider ?? "codex";
      const modelSelection = getModelSelection(provider);
      await client.dispatch({
        type: "thread.turn.start",
        commandId: `cmd-turn-${threadId}-${crypto.randomUUID().slice(0, 8)}`,
        threadId,
        message: {
          messageId: `msg-${crypto.randomUUID()}`,
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now(),
      });
    },

    async stopSession(threadId: string) {
      try {
        await client.dispatch({
          type: "thread.session.stop",
          commandId: `cmd-stop-${threadId}`,
          threadId,
          createdAt: now(),
        });
      } catch {
        // session may already be stopped
      }
    },

    async stopAll() {
      const stopPromises = [...sessions.keys()].map((tid) => this.stopSession(tid));
      await Promise.allSettled(stopPromises);
    },

    disconnect() {
      client.disconnect();
    },
  };
}

function getModelSelection(provider: string): Record<string, unknown> {
  switch (provider) {
    case "codex":
      return { provider: "codex", model: "gpt-5.3-codex" };
    case "claudeAgent":
      return { provider: "claudeAgent", model: "claude-sonnet-4-6" };
    case "cursor":
      return { provider: "cursor", model: "claude-4.6-sonnet-medium" };
    case "opencode":
      return { provider: "opencode", model: "claude-sonnet-4-6" };
    default:
      return { provider: "codex", model: "gpt-5.3-codex" };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = arr.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionState {
  threadId: string;
  provider: string;
  turnsCompleted: number;
  deltasReceived: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  turnStartedAt: number | null;
  turnCompletedAt: number | null;
  latencies: number[];
  errors: string[];
  text: string;
  approvalRequests: number;
}

interface MetricsSample {
  timestamp: number;
  elapsed_ms: number;
  beam: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  snapshot_server: Record<string, unknown>;
}

interface StepResult {
  step: number;
  totalSessions: number;
  perProvider: number;
  mockSessions: number;
  startedAt: number;
  completedAt: number;
  duration_ms: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsErrored: number;
  completionRate: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
  latency_max_ms: number;
  throughput_deltas_per_sec: number;
  metrics_before: MetricsSample | null;
  metrics_after: MetricsSample | null;
  metrics_peak: MetricsSample | null;
  perProviderStats: Record<
    string,
    {
      started: number;
      completed: number;
      errored: number;
      latency_p50_ms: number;
      latency_p99_ms: number;
      avg_deltas: number;
      errors: string[];
    }
  >;
  stopReason: string | null;
}

interface OOMResult {
  runId: number;
  startedAt: number;
  completedAt: number;
  steps: StepResult[];
  breakingPoint: { step: number; reason: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
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
    text: "",
    approvalRequests: 0,
  };
}

function createManager(sessions: Map<string, SessionState>): HarnessClientManager {
  return new HarnessClientManager({
    harnessPort: HARNESS_PORT,
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
        s.firstDeltaAt = null;
        s.turnStartedAt = null;
      }

      if (raw.method === "session/error") {
        s.errors.push(String(p?.message ?? p?.error ?? "unknown error"));
      }

      // Track approval requests (tool usage confirmation)
      if (raw.method === "exec_approval_request" || raw.method === "approval/requested") {
        s.approvalRequests++;
        // Auto-approve — we're in full-access mode but track it
      }
    },
    onSessionChanged: () => {},
    onDisconnect: () => {
      warn("Harness connection lost");
    },
    onReconnect: () => {
      ok("Harness reconnected");
    },
  });
}

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

function pickPrompt(provider: Provider, index: number): string {
  const prompts = TOOL_PROMPTS[provider];
  return prompts[index % prompts.length]!;
}

function computeProviderStats(sessions: Map<string, SessionState>): StepResult["perProviderStats"] {
  const stats: StepResult["perProviderStats"] = {};

  for (const provider of [...PROVIDERS, ...(SKIP_MOCK ? [] : ["mock" as const])]) {
    const providerSessions = [...sessions.values()].filter((s) => s.provider === provider);
    if (providerSessions.length === 0) continue;

    const completed = providerSessions.filter((s) => s.turnsCompleted > 0);
    const errored = providerSessions.filter((s) => s.errors.length > 0);
    const allLatencies = providerSessions.flatMap((s) => s.latencies);
    const allDeltas = providerSessions.map((s) => s.deltasReceived);
    const allErrors = providerSessions.flatMap((s) => s.errors);

    stats[provider] = {
      started: providerSessions.length,
      completed: completed.length,
      errored: errored.length,
      latency_p50_ms: percentile(allLatencies, 50),
      latency_p99_ms: percentile(allLatencies, 99),
      avg_deltas: allDeltas.reduce((a, b) => a + b, 0) / providerSessions.length,
      errors: [...new Set(allErrors)].slice(0, 10),
    };
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function runStep(
  stepIndex: number,
  totalSessions: number,
  codexBaseline: number,
): Promise<StepResult> {
  const perProvider = Math.floor(totalSessions / PROVIDERS.length);
  const mockCount = SKIP_MOCK || VISIBLE ? 0 : perProvider; // no mock in visible mode
  const actualTotal = perProvider * PROVIDERS.length + mockCount;

  console.log(`\n${"═".repeat(70)}`);
  console.log(
    `  STEP ${stepIndex + 1}: ${actualTotal} sessions ` +
      `(${perProvider}/provider × ${PROVIDERS.length} providers` +
      `${mockCount > 0 ? ` + ${mockCount} mock` : ""})`,
  );
  console.log(`${"═".repeat(70)}`);

  // Pre-step safety: check available memory via BEAM metrics + OS
  const systemMemGB = await getSystemMemoryGB();
  if (systemMemGB > 0) {
    const estimatedMB =
      perProvider * PROVIDERS.length * 150 + mockCount * 40;
    const safeGB = systemMemGB * 0.6;
    if (estimatedMB / 1024 > safeGB) {
      fail(
        `Step ${stepIndex + 1} needs ~${(estimatedMB / 1024).toFixed(1)}GB but only ${safeGB.toFixed(1)}GB safe. ` +
          `Skipping to prevent system freeze. Use --steps= to set lower targets.`,
      );
      return buildStepResult(stepIndex, actualTotal, perProvider, mockCount, Date.now(), new Map(), null, null, null,
        `Skipped: estimated ${(estimatedMB / 1024).toFixed(1)}GB exceeds ${safeGB.toFixed(1)}GB safe budget`,
      );
    }
  }

  const startedAt = Date.now();
  const sessions = new Map<string, SessionState>();

  // Choose adapter based on mode
  const mgr = VISIBLE ? null : createManager(sessions);
  const vis = VISIBLE ? createVisibleAdapter(sessions) : null;

  let metricsBefore: MetricsSample | null = null;
  let metricsAfter: MetricsSample | null = null;
  let metricsPeak: MetricsSample | null = null;
  let peakMemory = 0;

  try {
    if (vis) {
      await vis.connect();
      ok(`Connected to Node server (visible mode, project=${vis.projectId.slice(0, 8)})`);
    } else {
      await mgr!.connect();
      ok("Connected to harness");
    }
  } catch (e) {
    fail(`Cannot connect to harness: ${e}`);
    return {
      step: stepIndex + 1,
      totalSessions: actualTotal,
      perProvider,
      mockSessions: mockCount,
      startedAt,
      completedAt: Date.now(),
      duration_ms: Date.now() - startedAt,
      sessionsStarted: 0,
      sessionsCompleted: 0,
      sessionsErrored: 0,
      completionRate: 0,
      latency_p50_ms: 0,
      latency_p99_ms: 0,
      latency_max_ms: 0,
      throughput_deltas_per_sec: 0,
      metrics_before: null,
      metrics_after: null,
      metrics_peak: null,
      perProviderStats: {},
      stopReason: `Connection failed: ${e}`,
    };
  }

  try {
    metricsBefore = await fetchMetrics();
  } catch {
    warn("Could not fetch initial metrics");
  }

  // Phase 1: Start all sessions
  log("Starting sessions...");
  const startErrors: string[] = [];

  // Real providers
  for (const provider of PROVIDERS) {
    const batchStart = Date.now();
    for (let i = 0; i < perProvider; i++) {
      const threadId = VISIBLE
        ? crypto.randomUUID()
        : `oom-${stepIndex + 1}-${provider}-${i}-${Date.now()}`;
      sessions.set(threadId, createSessionState(threadId, provider));

      try {
        if (vis) {
          await vis.startSession(threadId, provider);
        } else {
          await mgr!.startSession({
            threadId,
            provider,
            cwd: CWD,
            runtimeMode: "full-access",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sessions.get(threadId)!.errors.push(`start: ${msg}`);
        startErrors.push(`${provider}[${i}]: ${msg}`);
      }
    }
    const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    log(`  ${provider}: ${perProvider} sessions started (${elapsed}s)`);
  }

  // Mock control group (skip in visible mode — mock has no UI representation)
  if (mockCount > 0 && !VISIBLE) {
    const batchStart = Date.now();
    for (let i = 0; i < mockCount; i++) {
      const threadId = `oom-${stepIndex + 1}-mock-${i}-${Date.now()}`;
      sessions.set(threadId, createSessionState(threadId, "mock"));

      try {
        await mgr!.startSession({
          threadId,
          provider: "mock",
          cwd: CWD,
          runtimeMode: "full-access",
          providerOptions: {
            mock: { deltaCount: 50, deltaSizeKb: 1, delayMs: 20, mode: "normal" },
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sessions.get(threadId)!.errors.push(`start: ${msg}`);
      }
    }
    const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    log(`  mock: ${mockCount} sessions started (${elapsed}s)`);
  }

  if (startErrors.length > 0) {
    warn(`${startErrors.length} session start errors (showing first 5):`);
    for (const err of startErrors.slice(0, 5)) {
      warn(`  ${err}`);
    }
  }

  const sessionsStarted = [...sessions.values()].filter((s) => s.errors.length === 0).length;
  ok(`${sessionsStarted}/${actualTotal} sessions alive`);

  if (DRY_RUN) {
    log("DRY RUN — skipping turns");
    await cleanup(mgr, vis);
    return buildStepResult(
      stepIndex,
      actualTotal,
      perProvider,
      mockCount,
      startedAt,
      sessions,
      metricsBefore,
      null,
      null,
      null,
    );
  }

  // Phase 2: Fire turns to all sessions simultaneously
  log("Firing turns to all sessions simultaneously...");
  const turnFireStart = Date.now();

  const sendPromises: Promise<void>[] = [];
  for (const [threadId, s] of sessions) {
    if (s.errors.length > 0) continue;

    const provider = s.provider as Provider;
    const prompt =
      provider === ("mock" as string)
        ? "test turn"
        : pickPrompt(provider, Math.floor(Math.random() * 100));

    const sendFn = vis
      ? vis.sendTurn(threadId, prompt)
      : mgr!.sendTurn(threadId, { input: [{ type: "text", text: prompt }] });

    sendPromises.push(
      sendFn
        .then(() => {})
        .catch((e) => {
          s.errors.push(`turn: ${e instanceof Error ? e.message : String(e)}`);
        }),
    );
  }
  await Promise.all(sendPromises);
  const fireElapsed = ((Date.now() - turnFireStart) / 1000).toFixed(1);
  log(`All turns dispatched (${fireElapsed}s to enqueue)`);

  // Phase 3: Wait for completion with metrics sampling
  log(`Waiting up to ${TURN_TIMEOUT_S}s for turns to complete...`);
  const deadline = Date.now() + TURN_TIMEOUT_S * 1000;

  while (Date.now() < deadline) {
    // Sample metrics
    try {
      const m = await fetchMetrics();
      const mem = (m.beam as Record<string, number>).total_memory ?? 0;
      if (mem > peakMemory) {
        peakMemory = mem;
        metricsPeak = m;
      }

      const qLen = (m.snapshot_server as Record<string, number>).message_queue_len ?? 0;
      if (qLen > 50) {
        warn(`SnapshotServer queue: ${qLen}`);
      }
    } catch {}

    // Check completion
    const alive = [...sessions.values()].filter((s) => s.errors.length === 0);
    const done = alive.filter((s) => s.turnsCompleted > 0);

    if (done.length >= alive.length) {
      ok(`All ${done.length} active sessions completed`);
      break;
    }

    // Progress update every 10s
    const elapsed = Math.floor((Date.now() - turnFireStart) / 1000);
    if (elapsed > 0 && elapsed % 10 === 0) {
      log(`  ${done.length}/${alive.length} completed (${elapsed}s elapsed)`);
    }

    await sleep(2000);
  }

  try {
    metricsAfter = await fetchMetrics();
  } catch {
    warn("Could not fetch final metrics");
  }

  // Phase 4: Report
  const allLatencies = [...sessions.values()].flatMap((s) => s.latencies);
  const totalDeltas = [...sessions.values()].reduce((a, s) => a + s.deltasReceived, 0);
  const wallTime = (Date.now() - turnFireStart) / 1000;

  const alive = [...sessions.values()].filter((s) => s.errors.length === 0);
  const completed = alive.filter((s) => s.turnsCompleted > 0);
  const errored = [...sessions.values()].filter((s) => s.errors.length > 0);

  const completionRate = actualTotal > 0 ? completed.length / actualTotal : 0;
  const p50 = percentile(allLatencies, 50);
  const p99 = percentile(allLatencies, 99);
  const maxLat = allLatencies.length > 0 ? Math.max(...allLatencies) : 0;

  console.log(`\n  ── Step ${stepIndex + 1} Results ──`);
  log(`Sessions: ${completed.length}/${sessionsStarted} completed, ${errored.length} errored`);
  log(`Completion rate: ${(completionRate * 100).toFixed(1)}%`);
  log(
    `Latency p50: ${(p50 / 1000).toFixed(1)}s  p99: ${(p99 / 1000).toFixed(1)}s  max: ${(maxLat / 1000).toFixed(1)}s`,
  );
  log(
    `Throughput: ${totalDeltas} deltas in ${wallTime.toFixed(1)}s = ${(totalDeltas / wallTime).toFixed(0)} deltas/s`,
  );

  if (metricsBefore && metricsAfter) {
    const memBefore = (metricsBefore.beam as Record<string, number>).total_memory ?? 0;
    const memAfter = (metricsAfter.beam as Record<string, number>).total_memory ?? 0;
    const procsBefore = (metricsBefore.beam as Record<string, number>).process_count ?? 0;
    const procsAfter = (metricsAfter.beam as Record<string, number>).process_count ?? 0;
    log(
      `BEAM memory: ${(memBefore / 1024 / 1024).toFixed(1)}MB → ${(memAfter / 1024 / 1024).toFixed(1)}MB (peak ${(peakMemory / 1024 / 1024).toFixed(1)}MB)`,
    );
    log(`BEAM processes: ${procsBefore} → ${procsAfter}`);
  }

  // Per-provider breakdown
  const providerStats = computeProviderStats(sessions);
  for (const [prov, ps] of Object.entries(providerStats)) {
    log(
      `  ${prov}: ${ps.completed}/${ps.started} done, ` +
        `p50=${(ps.latency_p50_ms / 1000).toFixed(1)}s p99=${(ps.latency_p99_ms / 1000).toFixed(1)}s, ` +
        `avg ${ps.avg_deltas.toFixed(0)} deltas` +
        (ps.errored > 0 ? ` (${ps.errored} errors)` : ""),
    );
  }

  // Check stop conditions — BEAM telemetry-based
  let stopReason: string | null = null;

  // 1. Completion rate (counts errored sessions as failures)
  if (completionRate < MIN_COMPLETION_RATE) {
    stopReason = `Completion rate ${(completionRate * 100).toFixed(1)}% < ${MIN_COMPLETION_RATE * 100}%`;
    fail(`STOP: ${stopReason}`);
  }

  // 2. Infrastructure errors (emfile, enomem, system_limit) — instant stop
  if (!stopReason) {
    const allErrors = [...sessions.values()].flatMap((s) => s.errors);
    const infraError = allErrors.find((e) =>
      INFRA_ERROR_PATTERNS.some((pat) => e.includes(pat)),
    );
    if (infraError) {
      stopReason = `Infrastructure error: ${infraError}`;
      fail(`STOP: ${stopReason}`);
    }
  }

  // 3. SnapshotServer queue saturation
  if (!stopReason && metricsPeak) {
    const peakQueue =
      (metricsPeak.snapshot_server as Record<string, number>).message_queue_len ?? 0;
    if (peakQueue > MAX_SNAPSHOT_QUEUE) {
      stopReason = `SnapshotServer queue peak ${peakQueue} > ${MAX_SNAPSHOT_QUEUE}`;
      warn(`DEGRADED: ${stopReason}`);
      // warn but don't stop — the system may recover
    }
  }

  // 4. BEAM memory growth
  if (!stopReason && metricsBefore && metricsPeak) {
    const memStart = (metricsBefore.beam as Record<string, number>).total_memory ?? 1;
    const memPeak = (metricsPeak.beam as Record<string, number>).total_memory ?? 0;
    if (memPeak > memStart * MAX_MEMORY_GROWTH_FACTOR) {
      stopReason = `BEAM memory ${(memPeak / 1024 / 1024).toFixed(0)}MB > ${MAX_MEMORY_GROWTH_FACTOR}x start (${(memStart / 1024 / 1024).toFixed(0)}MB)`;
      fail(`STOP: ${stopReason}`);
    }
  }

  // 5. Codex degradation ratio (canary — measures harness, not provider)
  if (!stopReason && codexBaseline > 0) {
    const codexStats = providerStats["codex"];
    if (codexStats && codexStats.latency_p50_ms > codexBaseline * CODEX_DEGRADATION_RATIO) {
      stopReason = `Codex p50 ${(codexStats.latency_p50_ms / 1000).toFixed(1)}s > ${CODEX_DEGRADATION_RATIO}x baseline (${(codexBaseline / 1000).toFixed(1)}s)`;
      fail(`STOP: ${stopReason}`);
    }
  }

  // Phase 5: Cleanup
  await cleanup(mgr, vis);

  return buildStepResult(
    stepIndex,
    actualTotal,
    perProvider,
    mockCount,
    startedAt,
    sessions,
    metricsBefore,
    metricsAfter,
    metricsPeak,
    stopReason,
  );
}

async function cleanup(mgr: HarnessClientManager | null, vis: VisibleAdapter | null): Promise<void> {
  log("Cleaning up sessions...");
  if (vis) {
    try {
      await vis.stopAll();
    } catch {}
    await sleep(3000);
    vis.disconnect();
  } else if (mgr) {
    try {
      await mgr.stopAll();
    } catch {}
    await sleep(5000);
    mgr.disconnect();
  }
  ok("Disconnected");
}

function buildStepResult(
  stepIndex: number,
  actualTotal: number,
  perProvider: number,
  mockCount: number,
  startedAt: number,
  sessions: Map<string, SessionState>,
  metricsBefore: MetricsSample | null,
  metricsAfter: MetricsSample | null,
  metricsPeak: MetricsSample | null,
  stopReason: string | null,
): StepResult {
  const alive = [...sessions.values()].filter((s) => s.errors.length === 0);
  const completed = alive.filter((s) => s.turnsCompleted > 0);
  const errored = [...sessions.values()].filter((s) => s.errors.length > 0);
  const allLatencies = [...sessions.values()].flatMap((s) => s.latencies);
  const totalDeltas = [...sessions.values()].reduce((a, s) => a + s.deltasReceived, 0);
  const wallTime = (Date.now() - startedAt) / 1000;

  return {
    step: stepIndex + 1,
    totalSessions: actualTotal,
    perProvider,
    mockSessions: mockCount,
    startedAt,
    completedAt: Date.now(),
    duration_ms: Date.now() - startedAt,
    sessionsStarted: alive.length + errored.length,
    sessionsCompleted: completed.length,
    sessionsErrored: errored.length,
    completionRate: actualTotal > 0 ? completed.length / actualTotal : 0,
    latency_p50_ms: percentile(allLatencies, 50),
    latency_p99_ms: percentile(allLatencies, 99),
    latency_max_ms: allLatencies.length > 0 ? Math.max(...allLatencies) : 0,
    throughput_deltas_per_sec: wallTime > 0 ? totalDeltas / wallTime : 0,
    metrics_before: metricsBefore,
    metrics_after: metricsAfter,
    metrics_peak: metricsPeak,
    perProviderStats: computeProviderStats(sessions),
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runId = Date.now();

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║         OOM CHALLENGE — Multi-Provider Concurrent Session Ramp       ║");
  console.log("╠══════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Steps: ${STEPS.join(" → ").padEnd(60)}║`);
  console.log(`║  Providers: ${PROVIDERS.join(", ").padEnd(56)}║`);
  console.log(
    `║  Mock control: ${SKIP_MOCK ? "disabled" : "enabled (1:1 ratio)"}${"".padEnd(SKIP_MOCK ? 47 : 35)}║`,
  );
  console.log(
    `║  Turn timeout: ${TURN_TIMEOUT_S}s${"".padEnd(55 - String(TURN_TIMEOUT_S).length)}║`,
  );
  console.log(
    `║  Stop: <${MIN_COMPLETION_RATE * 100}% completion, infra errors, Codex 5x degradation  ║`,
  );
  console.log(
    `║  Mode: ${VISIBLE ? "visible (Node WS → browser UI)" : "harness-direct (no UI)"}${"".padEnd(VISIBLE ? 33 : 38)}║`,
  );
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  // Verify connectivity
  if (VISIBLE) {
    try {
      const res = await fetch(`http://127.0.0.1:${NODE_PORT}`);
      if (!res.ok && res.status !== 302) throw new Error(`HTTP ${res.status}`);
      ok(`Node server reachable at port ${NODE_PORT}`);
    } catch (e) {
      fail(`Node server not reachable at port ${NODE_PORT}: ${e}`);
      process.exit(2);
    }
  }

  // Verify harness is reachable (needed for metrics in both modes)
  try {
    const res = await fetch(METRICS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok("Harness reachable at port " + HARNESS_PORT);
  } catch (e) {
    fail(`Harness not reachable at port ${HARNESS_PORT}: ${e}`);
    fail("Start with: ./scripts/dev-harness.sh");
    process.exit(2);
  }

  // Pre-flight: estimate system capacity
  const systemMemGB = await getSystemMemoryGB();
  if (systemMemGB > 0) {
    // ~150MB per real provider session, ~40MB per mock session
    const MB_PER_REAL_SESSION = 150;
    const MB_PER_MOCK_SESSION = 40;
    const maxStep = STEPS[STEPS.length - 1]!;
    const perProvider = Math.floor(maxStep / PROVIDERS.length);
    const mockCount = SKIP_MOCK ? 0 : perProvider;
    const estimatedMB =
      perProvider * PROVIDERS.length * MB_PER_REAL_SESSION + mockCount * MB_PER_MOCK_SESSION;
    const estimatedGB = estimatedMB / 1024;
    const safeGB = systemMemGB * 0.6; // leave 40% for OS + other processes

    log(`System RAM: ${systemMemGB.toFixed(1)}GB, safe budget: ${safeGB.toFixed(1)}GB`);
    log(`Peak step (${maxStep} sessions): ~${estimatedGB.toFixed(1)}GB estimated`);

    if (estimatedGB > safeGB) {
      const safeSessions = Math.floor(
        (safeGB * 1024) / (MB_PER_REAL_SESSION + (SKIP_MOCK ? 0 : MB_PER_MOCK_SESSION / PROVIDERS.length)),
      ) * PROVIDERS.length;
      warn(
        `Peak step needs ~${estimatedGB.toFixed(1)}GB but only ${safeGB.toFixed(1)}GB safe. ` +
          `Max safe: ~${safeSessions} sessions. Higher steps may freeze the system.`,
      );
    } else {
      ok(`Resource budget OK for all steps`);
    }
  }

  const results: StepResult[] = [];
  let breakingPoint: OOMResult["breakingPoint"] = null;
  let codexBaseline = 0; // captured from step 1, used as canary threshold

  for (let i = 0; i < STEPS.length; i++) {
    const stepResult = await runStep(i, STEPS[i]!, codexBaseline);
    results.push(stepResult);

    // Capture Codex baseline from step 1
    if (i === 0 && stepResult.perProviderStats["codex"]) {
      codexBaseline = stepResult.perProviderStats["codex"].latency_p50_ms;
      if (codexBaseline > 0) {
        log(`Codex baseline captured: p50=${(codexBaseline / 1000).toFixed(1)}s`);
      }
    }

    if (stepResult.stopReason) {
      breakingPoint = { step: STEPS[i]!, reason: stepResult.stopReason };
      warn(`Breaking point reached at ${STEPS[i]} sessions: ${stepResult.stopReason}`);
      break;
    }

    // Cooldown between steps
    if (i < STEPS.length - 1) {
      log(`Cooldown ${COOLDOWN_MS / 1000}s before next step...`);
      await sleep(COOLDOWN_MS);
    }
  }

  // Final report
  const oomResult: OOMResult = {
    runId,
    startedAt: results[0]?.startedAt ?? runId,
    completedAt: Date.now(),
    steps: results,
    breakingPoint,
  };

  const outPath = `${OUTPUT_DIR}/oom-challenge-${runId}.json`;
  writeFileSync(outPath, JSON.stringify(oomResult, null, 2));
  ok(`Results written to ${outPath}`);

  // Summary table
  console.log("\n" + "═".repeat(70));
  console.log("  OOM CHALLENGE SUMMARY");
  console.log("═".repeat(70));
  console.log("  Step  | Sessions | Completed | Rate   | p50      | p99      | Δ/s  ");
  console.log("  ------+----------+-----------+--------+----------+----------+------");
  for (const r of results) {
    console.log(
      `  ${String(r.step).padStart(5)} | ` +
        `${String(r.totalSessions).padStart(8)} | ` +
        `${String(r.sessionsCompleted).padStart(9)} | ` +
        `${(r.completionRate * 100).toFixed(1).padStart(5)}% | ` +
        `${(r.latency_p50_ms / 1000).toFixed(1).padStart(6)}s | ` +
        `${(r.latency_p99_ms / 1000).toFixed(1).padStart(6)}s | ` +
        `${r.throughput_deltas_per_sec.toFixed(0).padStart(4)}`,
    );
  }
  console.log("═".repeat(70));

  if (breakingPoint) {
    fail(`BREAKING POINT: ${breakingPoint.step} sessions — ${breakingPoint.reason}`);
  } else {
    ok(`ALL STEPS PASSED — system sustained ${STEPS[STEPS.length - 1]} concurrent sessions`);
  }

  const totalDuration = ((Date.now() - runId) / 1000).toFixed(0);
  log(`Total runtime: ${totalDuration}s`);
}

main().catch((e) => {
  fail(`Fatal: ${e}`);
  process.exit(2);
});
