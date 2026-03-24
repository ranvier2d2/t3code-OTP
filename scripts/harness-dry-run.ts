#!/usr/bin/env bun
/**
 * harness-dry-run.ts — End-to-end test of the Elixir HarnessService.
 *
 * What it does:
 * 1. Spawns the Elixir Phoenix server (mix phx.server)
 * 2. Waits for it to be ready (HTTP health check)
 * 3. Connects via WebSocket using Phoenix Channel protocol
 * 4. Joins "harness:lobby" channel
 * 5. Sends test commands: snapshot.get, session.listSessions
 * 6. Optionally tries session.start for each provider
 * 7. Reports results and exits
 *
 * Usage:
 *   bun run scripts/harness-dry-run.ts
 *   bun run scripts/harness-dry-run.ts --port 4321
 *   bun run scripts/harness-dry-run.ts --skip-providers  # skip session.start tests
 */
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HARNESS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "4321", 10);
const HARNESS_SECRET = process.env.T3CODE_HARNESS_SECRET ?? "dev-harness-secret";
const SKIP_PROVIDERS = process.argv.includes("--skip-providers");
const HARNESS_DIR = new URL("../apps/harness", import.meta.url).pathname;
const TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (tag: string, msg: string) => console.log(`[${tag}] ${msg}`);
const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => console.log(`  ✗ ${msg}`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phoenix Channel Protocol
// ---------------------------------------------------------------------------

type PhxMessage = [string | null, string | null, string, string, unknown];

class PhoenixChannelClient {
  private ws: WebSocket | null = null;
  private nextRef = 1;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private joinRef: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  public pushEvents: Array<{ event: string; payload: unknown }> = [];

  async connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Secret goes in URL params (Phoenix Socket.connect receives these)
      const url = `ws://127.0.0.1:${port}/socket/websocket?secret=${HARNESS_SECRET}&vsn=2.0.0`;
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 25_000);
        resolve();
      });

      this.ws.on("error", (err: Error) => {
        log("WS-ERR", `${err.message ?? err}`);
        reject(err);
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg: PhxMessage = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          // ignore non-JSON
        }
      });
    });
  }

  private handleMessage(msg: PhxMessage) {
    const [joinRef, ref, topic, event, payload] = msg;
    log(
      "WS-RX",
      `[${joinRef}, ${ref}, ${topic}, ${event}, ${JSON.stringify(payload).slice(0, 200)}]`,
    );

    if (event === "phx_reply" && ref != null) {
      // Phoenix may return ref as integer or string — normalize to string
      const refStr = String(ref);
      const pending = this.pending.get(refStr);
      if (pending) {
        this.pending.delete(refStr);
        const reply = payload as { status: string; response: unknown };
        if (reply.status === "ok") {
          pending.resolve(reply.response);
        } else {
          pending.reject(new Error(JSON.stringify(reply.response)));
        }
      } else {
        log(
          "WS-RX",
          `No pending request for ref=${refStr}, pending keys: [${[...this.pending.keys()]}]`,
        );
      }
    } else if (event !== "phx_reply") {
      this.pushEvents.push({ event, payload });
    }
  }

  async join(topic: string): Promise<unknown> {
    const ref = String(this.nextRef++);
    this.joinRef = ref;
    // Phoenix Channel join: [join_ref, ref, topic, "phx_join", params]
    // join_ref and ref must be the same for the join message
    return this.sendAndWait(ref, topic, "phx_join", { secret: HARNESS_SECRET });
  }

  async push(topic: string, event: string, payload: unknown): Promise<unknown> {
    const ref = String(this.nextRef++);
    // Must include the join_ref for channel messages
    return this.sendAndWait(this.joinRef, topic, event, payload, ref);
  }

  private sendAndWait(
    joinRef: string | null,
    topic: string,
    event: string,
    payload: unknown,
    ref?: string,
  ): Promise<unknown> {
    const actualRef = ref ?? joinRef ?? String(this.nextRef++);
    const msg: PhxMessage = [joinRef, actualRef, topic, event, payload];

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actualRef);
        reject(new Error(`Timeout waiting for reply to ${event}`));
      }, TIMEOUT);

      this.pending.set(actualRef, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      const json = JSON.stringify(msg);
      log("WS-TX", json.slice(0, 200));
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(json);
      } else {
        this.pending.delete(actualRef);
        clearTimeout(timer);
        reject(new Error("WebSocket not connected"));
      }
    });
  }

  private sendHeartbeat() {
    const ref = String(this.nextRef++);
    const msg: PhxMessage = [null, ref, "phoenix", "heartbeat", {}];
    this.ws?.send(JSON.stringify(msg));
  }

  disconnect() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let elixirProcess: ChildProcess | null = null;

async function main() {
  let passed = 0;
  let failed_ = 0;
  const results: Array<{ test: string; ok: boolean; detail?: string }> = [];

  const record = (test: string, ok: boolean, detail?: string) => {
    results.push({ test, ok, ...(detail !== undefined ? { detail } : {}) });
    if (ok) {
      pass(test);
      passed++;
    } else {
      fail(`${test}: ${detail}`);
      failed_++;
    }
  };

  try {
    // Step 1: Spawn Elixir
    log("SPAWN", `Starting Phoenix server on port ${HARNESS_PORT}...`);
    elixirProcess = spawn("mix", ["phx.server"], {
      cwd: HARNESS_DIR,
      env: {
        ...process.env,
        T3CODE_HARNESS_PORT: String(HARNESS_PORT),
        T3CODE_HARNESS_SECRET: HARNESS_SECRET,
        MIX_ENV: "dev",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    elixirProcess.stderr?.on("data", (data) => {
      const line = data.toString().trim();
      if (line && !line.includes("[debug]")) {
        log("ELIXIR", line);
      }
    });

    // Step 2: Wait for server
    log("WAIT", "Waiting for Phoenix to be ready...");
    const ready = await waitForServer(HARNESS_PORT);
    record(
      "Phoenix server starts",
      ready,
      ready ? undefined : "Server did not become ready within 30s",
    );
    if (!ready) throw new Error("Server not ready");

    log("READY", `Phoenix listening on port ${HARNESS_PORT}`);

    // Step 3: Connect WebSocket
    log("WS", "Connecting to Phoenix Channel...");
    const client = new PhoenixChannelClient();
    await client.connect(HARNESS_PORT);
    record("WebSocket connects", true);

    // Step 4: Join channel
    log("JOIN", 'Joining "harness:lobby"...');
    const joinResult = await client.join("harness:lobby");
    record("Channel join succeeds", true);

    // Step 5: snapshot.get
    log("TEST", "Sending snapshot.get...");
    const snapshot = (await client.push("harness:lobby", "snapshot.get", {})) as Record<
      string,
      unknown
    >;
    const hasSnapshot = snapshot && typeof snapshot === "object" && "snapshot" in snapshot;
    record(
      "snapshot.get returns data",
      hasSnapshot,
      hasSnapshot
        ? `sequence=${(snapshot.snapshot as Record<string, unknown>).sequence}`
        : "No snapshot in response",
    );

    // Step 6: session.listSessions
    log("TEST", "Sending session.listSessions...");
    const sessions = (await client.push("harness:lobby", "session.listSessions", {})) as Record<
      string,
      unknown
    >;
    const hasSessions = sessions && typeof sessions === "object" && "sessions" in sessions;
    record(
      "session.listSessions returns data",
      hasSessions,
      hasSessions ? `count=${(sessions.sessions as unknown[]).length}` : "No sessions in response",
    );

    // Step 7: Test each provider (optional)
    if (!SKIP_PROVIDERS) {
      const providers = ["codex", "claudeAgent", "opencode", "cursor"];
      for (const provider of providers) {
        log("TEST", `Trying session.start for ${provider}...`);
        try {
          const result = await client.push("harness:lobby", "session.start", {
            threadId: `dryrun-${provider}-${Date.now()}`,
            provider,
            cwd: "/tmp",
            model: provider === "claudeAgent" ? "claude-sonnet-4-6" : undefined,
          });
          record(`session.start(${provider}) accepted`, true, JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // "Unsupported provider" = real failure, anything else = binary not found (acceptable)
          const isUnsupported = msg.includes("Unsupported provider");
          record(
            `session.start(${provider}) recognized`,
            !isUnsupported,
            isUnsupported ? "Provider not registered" : `Expected failure: ${msg.slice(0, 100)}`,
          );
        }

        // Give session time to start/fail before next
        await sleep(500);
      }
    }

    // Step 8: Check for push events received
    log("TEST", `Received ${client.pushEvents.length} push events during test`);
    if (client.pushEvents.length > 0) {
      const eventTypes = [...new Set(client.pushEvents.map((e) => e.event))];
      record("Push events received", true, `types: ${eventTypes.join(", ")}`);
    }

    client.disconnect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Fatal: ${msg}`);
    failed_++;
  } finally {
    // Cleanup — wait for actual exit before escalating to SIGKILL
    if (elixirProcess) {
      const proc = elixirProcess;
      const exited = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(resolve, 2000);
      });
      proc.kill("SIGTERM");
      await exited;
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`HARNESS DRY-RUN: ${passed} passed, ${failed_} failed`);
  console.log("=".repeat(60));

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  ${icon} ${r.test}${detail}`);
  }

  process.exit(failed_ > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  if (elixirProcess) elixirProcess.kill("SIGKILL");
  process.exit(1);
});
