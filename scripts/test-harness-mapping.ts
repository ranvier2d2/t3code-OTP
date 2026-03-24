#!/usr/bin/env bun
/**
 * Phase 1: Event mapping integration test.
 *
 * Connects to the running Elixir harness, starts a Claude session,
 * sends a prompt, receives raw events, and verifies they map correctly
 * to canonical ProviderRuntimeEvent types.
 *
 * Usage:
 *   ./apps/harness/bin/harness start-bg
 *   bun run scripts/test-harness-mapping.ts
 */
import WebSocket from "ws";

const PORT = process.env.T3CODE_HARNESS_PORT ?? "4321";
const SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const URL = `ws://localhost:${PORT}/socket/websocket?secret=${SECRET}&vsn=2.0.0`;
const JOIN_REF = "1";

const PROVIDER = process.argv[2] ?? "claudeAgent";
const PROMPT = process.argv[3] ?? "What is 2+2? Answer in one word.";

let nextRef = 1;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// ── Minimal type definitions (matching the contracts) ──

interface HarnessRawEvent {
  eventId: string;
  threadId: string;
  provider: string;
  createdAt: string;
  kind: string;
  method: string;
  payload: unknown;
}

interface ProviderEvent {
  id: string;
  kind: "session" | "notification" | "request" | "error";
  provider: string;
  threadId: string;
  createdAt: string;
  method: string;
  message?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  payload?: unknown;
}

interface MappedEvent {
  type: string;
  payload?: unknown;
  threadId: string;
  provider: string;
}

// ── rawToProviderEvent (same logic as HarnessClientAdapter.ts) ──

function rawToProviderEvent(raw: HarnessRawEvent): ProviderEvent {
  const payload = (raw.payload && typeof raw.payload === "object" ? raw.payload : {}) as Record<
    string,
    unknown
  >;
  return {
    id: raw.eventId,
    kind: (["session", "notification", "request", "error"].includes(raw.kind)
      ? raw.kind
      : "notification") as ProviderEvent["kind"],
    provider: raw.provider,
    threadId: raw.threadId,
    createdAt: raw.createdAt,
    method: raw.method,
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
    ...(typeof payload.itemId === "string" ? { itemId: payload.itemId } : {}),
    ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
    payload: raw.payload,
  };
}

// ── Simple mapping (maps method → canonical event type) ──

function mapToCanonicalType(event: ProviderEvent): MappedEvent[] {
  const base = { threadId: event.threadId, provider: event.provider };

  // Session lifecycle
  if (event.method === "session/connecting")
    return [{ ...base, type: "session.state.changed", payload: { state: "connecting" } }];
  if (event.method === "session/started") return [{ ...base, type: "session.started" }];
  if (event.method === "session/ready")
    return [{ ...base, type: "session.state.changed", payload: { state: "ready" } }];
  if (event.method === "session/configured")
    return [{ ...base, type: "session.configured", payload: event.payload }];
  if (event.method === "session/exited") return [{ ...base, type: "session.exited" }];
  if (event.method.startsWith("session/state"))
    return [{ ...base, type: "session.state.changed", payload: event.payload }];

  // Turn lifecycle
  if (event.method === "turn/started")
    return [{ ...base, type: "turn.started", payload: event.payload }];
  if (event.method === "turn/completed")
    return [{ ...base, type: "turn.completed", payload: event.payload }];

  // Content
  if (event.method === "content/delta")
    return [{ ...base, type: "content.delta", payload: event.payload }];
  if (event.method.includes("agentMessage/delta") || event.method.includes("agent_message"))
    return [{ ...base, type: "content.delta", payload: event.payload }];

  // Items
  if (event.method === "item/started" || event.method.includes("item_started"))
    return [{ ...base, type: "item.started", payload: event.payload }];
  if (event.method === "item/completed" || event.method.includes("item_completed"))
    return [{ ...base, type: "item.completed", payload: event.payload }];
  if (event.method === "item/updated")
    return [{ ...base, type: "item.updated", payload: event.payload }];

  // Requests/permissions
  if (event.method === "request/opened")
    return [{ ...base, type: "request.opened", payload: event.payload }];
  if (event.method === "request/resolved")
    return [{ ...base, type: "request.resolved", payload: event.payload }];
  if (event.method === "user-input/requested")
    return [{ ...base, type: "user-input.requested", payload: event.payload }];

  // Token usage
  if (event.method.includes("token") || event.method.includes("rateLimits"))
    return [{ ...base, type: "account.updated", payload: event.payload }];

  // Error
  if (event.kind === "error") return [{ ...base, type: "runtime.error", payload: event.payload }];

  // Pass-through (unknown method)
  return [{ ...base, type: `unmapped:${event.method}`, payload: event.payload }];
}

// ── Phoenix Channel helpers ──

function send(ws: WebSocket, event: string, payload: Record<string, unknown>): Promise<unknown> {
  const ref = String(nextRef++);
  const msg = JSON.stringify([JOIN_REF, ref, "harness:lobby", event, payload]);
  return new Promise((resolve, reject) => {
    pending.set(ref, { resolve, reject });
    ws.send(msg);
    setTimeout(() => {
      if (pending.has(ref)) {
        pending.delete(ref);
        reject(new Error(`Timeout: ${event}`));
      }
    }, 30_000);
  });
}

// ── Main ──

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Phase 1: Event Mapping Integration Test`);
  console.log(`  Provider: ${PROVIDER}  Prompt: "${PROMPT}"`);
  console.log(`${"=".repeat(60)}\n`);

  const ws = new WebSocket(URL);
  const rawEvents: HarnessRawEvent[] = [];
  const mappedEvents: MappedEvent[] = [];
  const unmappedMethods: string[] = [];

  ws.on("error", (err: Error) => {
    console.error("WebSocket error:", err.message);
    process.exit(1);
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    const msg = JSON.parse(raw.toString());
    const [, ref, , event, payload] = msg as [
      string | null,
      string | null,
      string,
      string,
      Record<string, unknown>,
    ];

    if (event === "phx_reply" && ref && pending.has(ref)) {
      const { resolve, reject } = pending.get(ref)!;
      pending.delete(ref);
      const p = payload as { status: string; response: unknown };
      if (p.status === "ok") resolve(p.response);
      else reject(new Error(JSON.stringify(p.response)));
      return;
    }

    if (event === "harness.event") {
      const rawEvent: HarnessRawEvent = {
        eventId: (payload.eventId as string) ?? "",
        threadId: (payload.threadId as string) ?? "",
        provider: (payload.provider as string) ?? "",
        createdAt: (payload.createdAt as string) ?? "",
        kind: (payload.kind as string) ?? "",
        method: (payload.method as string) ?? "",
        payload: payload.payload,
      };
      rawEvents.push(rawEvent);

      // Step 1: raw → ProviderEvent
      const providerEvent = rawToProviderEvent(rawEvent);

      // Step 2: ProviderEvent → canonical type
      const canonical = mapToCanonicalType(providerEvent);
      mappedEvents.push(...canonical);

      for (const c of canonical) {
        const isUnmapped = c.type.startsWith("unmapped:");
        if (isUnmapped) unmappedMethods.push(c.type.replace("unmapped:", ""));

        const icon = isUnmapped ? "\x1b[33m?" : "\x1b[32m✓";
        const typeColor = isUnmapped ? "\x1b[33m" : "\x1b[36m";
        console.log(
          `  ${icon}\x1b[0m raw: \x1b[90m${rawEvent.method}\x1b[0m → ${typeColor}${c.type}\x1b[0m`,
        );
      }
    }
  });

  await new Promise<void>((r) => ws.on("open", r));

  // Join
  await send(ws, "phx_join", { secret: SECRET });
  console.log("Connected to harness\n");

  // Start session
  const threadId = `mapping-test-${Date.now()}`;
  console.log(`── Starting ${PROVIDER} session ──\n`);
  await send(ws, "session.start", {
    threadId,
    provider: PROVIDER,
    cwd: process.cwd(),
    model: PROVIDER === "claudeAgent" ? "claude-sonnet-4-6" : undefined,
  });

  // Wait for session ready
  console.log("Waiting for session ready...\n");
  await new Promise((r) => setTimeout(r, 5_000));

  // Send turn
  console.log(`── Sending prompt ──\n`);
  try {
    await send(ws, "session.sendTurn", {
      threadId,
      input: [{ type: "text", text: PROMPT }],
    });
  } catch (e) {
    console.log(`  Turn send error: ${(e as Error).message}\n`);
  }

  // Collect events
  console.log("\nCollecting events...\n");
  let lastCount = rawEvents.length;
  let idle = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (rawEvents.length === lastCount) {
      idle++;
      if (idle >= 15) break;
    } else {
      idle = 0;
      lastCount = rawEvents.length;
    }
  }

  // ── Report ──
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  RESULTS`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`  Raw events received:    ${rawEvents.length}`);
  console.log(
    `  Mapped to canonical:    ${mappedEvents.filter((e) => !e.type.startsWith("unmapped:")).length}`,
  );
  console.log(`  Unmapped (pass-through): ${unmappedMethods.length}`);

  if (unmappedMethods.length > 0) {
    console.log(`\n  Unmapped methods:`);
    const unique = [...new Set(unmappedMethods)];
    for (const m of unique) {
      const count = unmappedMethods.filter((x) => x === m).length;
      console.log(`    - ${m} (${count}x)`);
    }
  }

  // Type distribution
  const typeCounts = new Map<string, number>();
  for (const e of mappedEvents) {
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }

  console.log(`\n  Event type distribution:`);
  for (const [type, count] of [...typeCounts.entries()].sort()) {
    const bar = "█".repeat(Math.min(count, 30));
    console.log(`    ${type.padEnd(30)} ${String(count).padStart(3)} ${bar}`);
  }

  // Key checks
  console.log(`\n  Key checks:`);
  const hasSessionStarted = mappedEvents.some((e) => e.type === "session.started");
  const hasTurnStarted = mappedEvents.some((e) => e.type === "turn.started");
  const hasTurnCompleted = mappedEvents.some((e) => e.type === "turn.completed");
  const hasContentDelta = mappedEvents.some((e) => e.type === "content.delta");
  const hasSessionExited = mappedEvents.some((e) => e.type === "session.exited");

  const check = (ok: boolean, label: string) =>
    console.log(`    ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${label}`);
  check(hasSessionStarted, "session.started received");
  check(hasTurnStarted, "turn.started received");
  check(hasContentDelta, "content.delta received (assistant text)");
  check(hasTurnCompleted, "turn.completed received");
  check(hasSessionExited, "session.exited received (process ended)");

  const mappingRate =
    rawEvents.length > 0
      ? Math.round(
          (mappedEvents.filter((e) => !e.type.startsWith("unmapped:")).length / rawEvents.length) *
            100,
        )
      : 0;
  console.log(`\n  Mapping coverage: ${mappingRate}%`);

  if (mappingRate >= 80) {
    console.log(`  \x1b[32m✓ PASS\x1b[0m — event mapping integration working`);
  } else if (mappingRate >= 50) {
    console.log(`  \x1b[33m~ PARTIAL\x1b[0m — some events unmapped, needs work`);
  } else {
    console.log(`  \x1b[31m✗ FAIL\x1b[0m — most events unmapped`);
  }

  // Cleanup
  try {
    await send(ws, "session.stop", { threadId });
  } catch {}
  console.log("");
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
