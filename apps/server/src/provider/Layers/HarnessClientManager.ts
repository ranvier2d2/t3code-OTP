/**
 * HarnessClientManager — Phoenix Channel WebSocket client for the Elixir HarnessService.
 *
 * Manages the WebSocket connection to the Harness Phoenix app, implements the
 * Phoenix Channel wire protocol (5-element JSON arrays), and exposes a typed
 * command interface for the adapter layer above it.
 *
 * The Elixir process itself is NOT spawned here — that is the responsibility of
 * the adapter layer. This class assumes the server is already running on
 * `ws://localhost:${harnessPort}/socket/websocket`.
 *
 * @module HarnessClientManager
 */
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessClientManagerOptions {
  readonly harnessPort: number;
  readonly harnessSecret: string;
  readonly onEvent: (event: HarnessRawEvent) => void;
  readonly onSessionChanged: (data: { threadId: string; session: unknown }) => void;
  readonly onDisconnect: () => void;
  readonly onReconnect: () => void;
}

export interface HarnessRawEvent {
  readonly eventId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly method: string;
  readonly payload: unknown;
  readonly seq?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A pending request waiting for a phx_reply from the server.
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Five-element Phoenix Channel message tuple:
 * [join_ref, ref, topic, event, payload]
 */
type PhxMessage = [string | null, string | null, string, string, Record<string, unknown>];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_TOPIC = "harness:lobby";
const HEARTBEAT_TOPIC = "phoenix";
const PHX_JOIN = "phx_join";
const PHX_REPLY = "phx_reply";
const PHX_LEAVE = "phx_leave"; // eslint-disable-line @typescript-eslint/no-unused-vars
const HEARTBEAT_EVENT = "heartbeat";

const REQUEST_TIMEOUT_MS = 30_000;
// Session start blocks on Elixir's wait_for_ready (60s). Give Node 65s so it
// never times out before the harness does.
const SESSION_START_TIMEOUT_MS = 65_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

// ---------------------------------------------------------------------------
// HarnessClientManager
// ---------------------------------------------------------------------------

export class HarnessClientManager {
  private readonly options: HarnessClientManagerOptions;

  /** WebSocket instance — replaced on each connect/reconnect cycle. */
  private ws: WebSocket | null = null;

  /** Monotonically increasing ref counter for outbound messages. */
  private refCounter = 0;

  /** join_ref used for the current channel join handshake. */
  private joinRef: string | null = null;

  /** Whether the channel join has been acknowledged by the server. */
  private channelJoined = false;

  /** Pending requests keyed by their string ref. */
  private readonly pending = new Map<string, PendingRequest>();

  /** NodeJS timer handle for periodic heartbeats. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Current index into RECONNECT_DELAYS_MS. Resets on successful join. */
  private reconnectAttempt = 0;

  /** Whether disconnect() has been called intentionally (suppresses reconnect). */
  private intentionalDisconnect = false;

  /** Last seen event sequence number — used for replay on reconnect. */
  private lastSeenSeq = 0;

  constructor(options: HarnessClientManagerOptions) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Establish the WebSocket connection and join the Phoenix channel.
   * Resolves once the channel join is acknowledged.
   */
  connect(): Promise<void> {
    this.intentionalDisconnect = false;
    return this.doConnect();
  }

  /**
   * Tear down the connection and suppress any reconnect attempts.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanup();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async startSession(params: Record<string, unknown>): Promise<unknown> {
    const result = await this.push("session.start", params, SESSION_START_TIMEOUT_MS);
    // Phoenix replies {:ok, %{session: session}} — unwrap the envelope.
    if (result && typeof result === "object" && "session" in result) {
      return (result as Record<string, unknown>).session;
    }
    return result;
  }

  sendTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    return this.push("session.sendTurn", { threadId, ...params });
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    await this.push("session.interrupt", {
      threadId,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }

  async respondToApproval(threadId: string, requestId: string, decision: string): Promise<void> {
    await this.push("session.respondToApproval", {
      threadId,
      requestId,
      decision,
    });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    await this.push("session.respondToUserInput", {
      threadId,
      requestId,
      answers,
    });
  }

  async stopSession(threadId: string): Promise<void> {
    await this.push("session.stop", { threadId });
  }

  readThread(threadId: string): Promise<unknown> {
    return this.push("session.readThread", { threadId });
  }

  rollbackThread(threadId: string, numTurns: number): Promise<unknown> {
    return this.push("session.rollbackThread", { threadId, numTurns });
  }

  async listSessions(): Promise<unknown[]> {
    const result = await this.push("session.listSessions", {});
    if (Array.isArray(result)) {
      return result;
    }
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as Record<string, unknown>).sessions)
    ) {
      return (result as Record<string, unknown>).sessions as unknown[];
    }
    return [];
  }

  async listProviderModels(provider: string): Promise<Array<{ slug: string; name: string }>> {
    try {
      const result = await this.push("provider.listModels", { provider });
      const models =
        result &&
        typeof result === "object" &&
        Array.isArray((result as Record<string, unknown>).models)
          ? ((result as Record<string, unknown>).models as Array<{ slug: string; name: string }>)
          : [];
      return models.filter((m) => typeof m.slug === "string" && typeof m.name === "string");
    } catch {
      return [];
    }
  }

  async mcpStatus(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.push("mcp.status", { threadId });
    if (result && typeof result === "object" && "status" in (result as Record<string, unknown>)) {
      return (result as Record<string, unknown>).status as Record<string, unknown>;
    }
    return (result as Record<string, unknown>) ?? {};
  }

  async mcpAdd(
    threadId: string,
    name: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.push("mcp.add", { threadId, name, config });
    return (result as Record<string, unknown>) ?? {};
  }

  async mcpConnect(threadId: string, name: string): Promise<void> {
    await this.push("mcp.connect", { threadId, name });
  }

  async mcpDisconnect(threadId: string, name: string): Promise<void> {
    await this.push("mcp.disconnect", { threadId, name });
  }

  async stopAll(): Promise<void> {
    await this.push("session.stopAll", {});
  }

  getSnapshot(): Promise<unknown> {
    return this.push("snapshot.get", {});
  }

  // -------------------------------------------------------------------------
  // Private — connection management
  // -------------------------------------------------------------------------

  // NOTE: The secret is passed as a query param because Phoenix.Socket.connect/3
  // reads params from the URL. This is acceptable for local-only connections
  // (127.0.0.1). For production, use TLS or header-based auth.
  private get socketUrl(): string {
    return `ws://127.0.0.1:${this.options.harnessPort}/socket/websocket?secret=${encodeURIComponent(this.options.harnessSecret)}&vsn=2.0.0`;
  }

  private nextRef(): string {
    this.refCounter += 1;
    return String(this.refCounter);
  }

  /**
   * Open the WebSocket, attach handlers, and wait for the channel join reply.
   */
  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.socketUrl);
      this.ws = ws;

      const onceOpenError = (err: unknown) => {
        ws.removeEventListener("open", onOpen);
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onOpen = () => {
        ws.removeEventListener("error", onceOpenError);
        // Send channel join — resolve/reject via the pending request machinery.
        this.channelJoined = false;
        const joinRef = this.nextRef();
        this.joinRef = joinRef;

        const joinPromise = this.pendingRequest(joinRef);
        const frame = this.buildFrame(joinRef, joinRef, CHANNEL_TOPIC, PHX_JOIN, {
          secret: this.options.harnessSecret,
        });
        this.sendRaw(frame);

        joinPromise
          .then(() => {
            this.channelJoined = true;
            this.reconnectAttempt = 0;
            this.startHeartbeat();
            resolve();
          })
          .catch((err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      };

      ws.addEventListener("open", onOpen);
      ws.on("error", onceOpenError);

      ws.on("message", (data) => this.handleMessage(data));

      ws.on("close", () => {
        this.stopHeartbeat();
        this.rejectAllPending(new Error("WebSocket closed"));
        this.channelJoined = false;
        this.options.onDisconnect();
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        // Errors after the initial open/join phase are handled via close.
        // Suppress so Node doesn't throw an unhandled error event.
        void err;
      });
    });
  }

  /**
   * Exponential back-off reconnect. After a successful rejoin the counter resets.
   */
  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] ??
      8_000;
    this.reconnectAttempt += 1;

    setTimeout(() => {
      if (this.intentionalDisconnect) return;
      this.doConnect()
        .then(() => {
          // Replay missed events from the WAL
          this.replayMissedEvents().then(() => {
            this.options.onReconnect();
          });
        })
        .catch((err) => {
          console.error("[HarnessClientManager] reconnect failed:", err);
          // doConnect's close handler will trigger another scheduleReconnect.
        });
    }, delay);
  }

  /**
   * After reconnect, ask the server for events we missed during the disconnect.
   * The server maintains a ring buffer (WAL) of the last 500 events with
   * monotonic sequence numbers. We send our lastSeenSeq and get back the diff.
   */
  private async replayMissedEvents(): Promise<void> {
    if (this.lastSeenSeq === 0) return; // First connect — no replay needed

    try {
      const result = await this.push("events.replay", {
        afterSeq: this.lastSeenSeq,
      });

      const resultObj = result as Record<string, unknown>;
      const events = resultObj.events;
      if (Array.isArray(events)) {
        for (const eventMap of events) {
          const rawEvent = this.parseRawEvent(eventMap as Record<string, unknown>);
          if (rawEvent) {
            const seq = (eventMap as Record<string, unknown>).seq;
            if (typeof seq === "number" && seq > this.lastSeenSeq) {
              this.lastSeenSeq = seq;
            }
            this.options.onEvent(rawEvent);
          }
        }
      }
    } catch (err) {
      // Replay failed — likely a WAL gap (events evicted from ring buffer).
      // Reset lastSeenSeq so future reconnects don't attempt partial replay
      // against a stale sequence number. The next full event stream will
      // rebuild state from the live harness.
      this.lastSeenSeq = 0;
      console.warn(
        "[HarnessClientManager] Event replay failed (WAL gap), reset to full sync",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.rejectAllPending(new Error("HarnessClientManager disconnected"));
    this.channelJoined = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore errors during forced close.
      }
      this.ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private — heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const ref = this.nextRef();
      // Heartbeat replies are handled inline; we don't need to track them.
      const frame = this.buildFrame(null, ref, HEARTBEAT_TOPIC, HEARTBEAT_EVENT, {});
      this.sendRaw(frame);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private — message handling
  // -------------------------------------------------------------------------

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!Array.isArray(parsed) || parsed.length !== 5) {
      return;
    }

    const [joinRef, ref, topic, event, payload] = parsed as PhxMessage;

    if (event === PHX_REPLY) {
      this.handleReply(joinRef, ref, topic, payload);
      return;
    }

    // Server-push events on the harness channel.
    if (topic === CHANNEL_TOPIC && ref === null) {
      this.handlePush(event, payload);
      return;
    }
  }

  private handleReply(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    payload: Record<string, unknown>,
  ): void {
    // Resolve a pending request if ref matches.
    // Phoenix may return ref as integer — normalize to string for lookup.
    const refStr = ref !== null ? String(ref) : null;
    if (refStr !== null) {
      const pending = this.pending.get(refStr);
      if (pending) {
        this.pending.delete(refStr);
        clearTimeout(pending.timer);

        const status = payload.status;
        if (status === "ok") {
          pending.resolve(payload.response ?? null);
        } else {
          const response = payload.response as Record<string, unknown> | undefined;
          const message =
            typeof response?.message === "string"
              ? response.message
              : `Harness replied with status '${String(status)}' for ref '${ref}' on topic '${topic}'`;
          pending.reject(new Error(message));
        }
        return;
      }
    }

    // Heartbeat replies carry the phoenix topic — ignore silently.
    if (topic === HEARTBEAT_TOPIC) {
      return;
    }

    void joinRef; // not used beyond channel join tracking
  }

  /**
   * Handle a server-initiated push (not a reply to a client message).
   */
  private handlePush(event: string, payload: Record<string, unknown>): void {
    if (event === "harness.event") {
      const rawEvent = this.parseRawEvent(payload);
      if (rawEvent) {
        // Track sequence number for replay on reconnect
        if (typeof payload.seq === "number" && payload.seq > this.lastSeenSeq) {
          this.lastSeenSeq = payload.seq;
        }
        this.options.onEvent(rawEvent);
      }
      return;
    }

    if (event === "session.changed" || event === "harness.session.changed") {
      const threadId =
        typeof payload.threadId === "string"
          ? payload.threadId
          : typeof payload.thread_id === "string"
            ? payload.thread_id
            : "";
      if (threadId) {
        this.options.onSessionChanged({ threadId, session: payload.session ?? null });
      }
      return;
    }
  }

  private parseRawEvent(payload: Record<string, unknown>): HarnessRawEvent | null {
    // Elixir sends camelCase keys (eventId, threadId, createdAt).
    // Accept both snake_case and camelCase for robustness.
    const eventId =
      typeof payload.eventId === "string"
        ? payload.eventId
        : typeof payload.event_id === "string"
          ? payload.event_id
          : "";
    const threadId =
      typeof payload.threadId === "string"
        ? payload.threadId
        : typeof payload.thread_id === "string"
          ? payload.thread_id
          : "";
    const provider = typeof payload.provider === "string" ? payload.provider : "harness";
    const createdAt =
      typeof payload.createdAt === "string"
        ? payload.createdAt
        : typeof payload.created_at === "string"
          ? payload.created_at
          : new Date().toISOString();
    const kind = typeof payload.kind === "string" ? payload.kind : "notification";
    const method = typeof payload.method === "string" ? payload.method : "";

    if (!eventId || !threadId || !method) {
      return null;
    }

    return {
      eventId,
      threadId,
      provider,
      createdAt,
      kind,
      method,
      payload: payload.payload ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Private — request/reply machinery
  // -------------------------------------------------------------------------

  /**
   * Send an event to the channel and return a Promise that resolves with the
   * server's reply response payload (or rejects on error/timeout).
   */
  private push(
    event: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.channelJoined) {
      return Promise.reject(
        new Error(
          `HarnessClientManager: cannot push '${event}' — channel is not joined (connected=${this.ws?.readyState === WebSocket.OPEN}, joined=${this.channelJoined})`,
        ),
      );
    }

    const ref = this.nextRef();
    // Phoenix requires the join_ref on all channel messages
    const frame = this.buildFrame(this.joinRef, ref, CHANNEL_TOPIC, event, params);
    const promise = this.pendingRequest(ref, timeoutMs);
    this.sendRaw(frame);
    return promise;
  }

  /**
   * Register a pending request for the given ref and return its promise.
   * The promise rejects automatically after REQUEST_TIMEOUT_MS.
   */
  private pendingRequest(ref: string, timeoutMs?: number): Promise<unknown> {
    const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(ref)) {
          this.pending.delete(ref);
          reject(
            new Error(`HarnessClientManager: request ref='${ref}' timed out after ${timeout}ms`),
          );
        }
      }, timeout);

      this.pending.set(ref, { resolve, reject, timer });
    });
  }

  private rejectAllPending(reason: Error): void {
    for (const [ref, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(ref);
    }
  }

  // -------------------------------------------------------------------------
  // Private — wire helpers
  // -------------------------------------------------------------------------

  private buildFrame(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): string {
    const msg: PhxMessage = [joinRef, ref, topic, event, payload];
    return JSON.stringify(msg);
  }

  private sendRaw(frame: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }
}
