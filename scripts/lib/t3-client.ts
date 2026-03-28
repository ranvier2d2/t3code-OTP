/**
 * T3Client -- WebSocket client for the t3code Node server.
 *
 * Extracted from stress-test-oom-challenge.ts and stress-test-hypotheses.ts
 * to avoid duplication. Dependency-light: only `ws` and `node:crypto`.
 *
 * Usage:
 *   import { T3Client } from "./lib/t3-client";
 *   const client = new T3Client();
 *   const welcome = await client.connect();
 *   const projectId = welcome.bootstrapProjectId;
 */

import { WebSocket } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface PushEvent {
  channel: string;
  data: Record<string, unknown>;
}

export interface T3ClientOptions {
  /** WebSocket port. Defaults to T3CODE_PORT env var or 3780. */
  port?: number;
  /** Optional auth token appended as ?token= query param. */
  authToken?: string;
  /** Per-request timeout in ms. Defaults to 120_000 (2 minutes). */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// T3Client
// ---------------------------------------------------------------------------

export class T3Client {
  private ws: WebSocket | undefined;
  private pending = new Map<string, PendingRequest>();
  private pushListeners: Array<(event: PushEvent) => void> = [];
  private readonly port: number;
  private readonly authToken: string;
  private readonly requestTimeout: number;

  constructor(options?: T3ClientOptions) {
    this.port = options?.port ?? T3Client.resolvePort();
    this.authToken = options?.authToken ?? T3Client.resolveAuthToken();
    this.requestTimeout = options?.requestTimeout ?? 120_000;
  }

  private static get baseDir(): string {
    return process.env.T3CODE_HOME?.trim() || path.join(os.homedir(), ".t3");
  }

  /** Resolve port: T3CODE_PORT env > ~/.t3/desktop-port file > 3780 default */
  private static resolvePort(): number {
    const envPortRaw = process.env.T3CODE_PORT?.trim();
    if (envPortRaw) {
      const envPort = parseInt(envPortRaw, 10);
      if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535) {
        return envPort;
      }
    }
    try {
      const content = fs.readFileSync(path.join(T3Client.baseDir, "desktop-port"), "utf-8").trim();
      const port = parseInt(content, 10);
      if (!Number.isNaN(port) && port > 0) return port;
    } catch {
      // Port file doesn't exist — fall through to default
    }
    return 3780;
  }

  /** Resolve auth token: T3CODE_AUTH_TOKEN env > ~/.t3/desktop-token file > empty */
  private static resolveAuthToken(): string {
    if (process.env.T3CODE_AUTH_TOKEN) return process.env.T3CODE_AUTH_TOKEN;
    try {
      return fs.readFileSync(path.join(T3Client.baseDir, "desktop-token"), "utf-8").trim();
    } catch {
      return "";
    }
  }

  /**
   * Open the WebSocket connection and wait for the `server.welcome` push.
   * Returns the welcome data (contains `bootstrapProjectId`).
   */
  async connect(): Promise<Record<string, unknown>> {
    const base = `ws://127.0.0.1:${this.port}`;
    const url = this.authToken ? `${base}?token=${encodeURIComponent(this.authToken)}` : base;

    return new Promise((resolve, reject) => {
      let settled = false;

      const handshakeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.ws?.close();
          reject(
            new Error(`Timed out waiting for server.welcome (${this.requestTimeout / 1000}s)`),
          );
        }
      }, this.requestTimeout);

      this.ws = new WebSocket(url);

      this.ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          reject(err);
        }
      });

      this.ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Push messages
        if (msg.type === "push" && msg.channel) {
          if (msg.channel === "server.welcome") {
            settled = true;
            clearTimeout(handshakeTimer);
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

        // Request/response correlation
        const id = msg.id as string | undefined;
        if (!id) return;

        // Schema-level error with id="unknown" rejects all pending
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
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          reject(new Error("WebSocket closed before server.welcome"));
        }
        for (const [, p] of this.pending) {
          p.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  /** Register a listener for server push events. */
  onPush(listener: (event: PushEvent) => void) {
    this.pushListeners.push(listener);
  }

  /**
   * Send a generic WS request. The `method` becomes the `_tag` field.
   * For `orchestration.dispatchCommand`, the params are wrapped as `{ command: params }`.
   * For other methods, params are spread into the body.
   */
  async send(method: string, params?: unknown): Promise<unknown> {
    const id = crypto.randomUUID();
    const body =
      method === "orchestration.dispatchCommand"
        ? { _tag: method, command: params }
        : params && typeof params === "object" && !Array.isArray(params)
          ? { _tag: method, ...(params as Record<string, unknown>) }
          : { _tag: method };

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      this.pending.set(id, { resolve, reject });

      try {
        this.ws.send(JSON.stringify({ id, body }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout (${this.requestTimeout / 1000}s): ${method}`));
        }
      }, this.requestTimeout);
    });
  }

  /**
   * Shorthand: dispatch an orchestration command.
   * Equivalent to `send("orchestration.dispatchCommand", command)`.
   */
  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.send("orchestration.dispatchCommand", command);
  }

  /** Close the WebSocket connection. */
  disconnect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.ws.close();
    }
    this.ws = undefined;
  }
}
