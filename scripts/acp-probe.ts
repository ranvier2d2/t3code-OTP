#!/usr/bin/env bun
/**
 * ACP Protocol Probe — Interactive CLI for reverse-engineering Cursor's ACP JSON-RPC protocol.
 *
 * Usage:
 *   bun run scripts/acp-probe.ts                          # interactive mode
 *   bun run scripts/acp-probe.ts --prompt "hello"         # single prompt, then exit
 *   bun run scripts/acp-probe.ts --model "composer-2[fast=true]" --prompt "hi"
 *   bun run scripts/acp-probe.ts --capture /tmp/wire.ndjson
 *
 * Handles the full handshake automatically (initialize → authenticate → session/new),
 * then accepts commands. All wire traffic logged to stdout and optionally to a capture file.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { appendFileSync, writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flagIndex = (flag: string) => args.indexOf(flag);
const flagValue = (flag: string) => {
  const i = flagIndex(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const CAPTURE_FILE = flagValue("--capture");
const INITIAL_PROMPT = flagValue("--prompt");
const MODEL = flagValue("--model");
const CWD = flagValue("--cwd") ?? process.cwd();
const MCP_JSON = flagValue("--mcp"); // path to mcp servers JSON array file
const QUIET = args.includes("--quiet");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let nextId = 1;
let sessionId: string | null = null;
let pendingPromises = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
>();
let buffer = "";

// ---------------------------------------------------------------------------
// Wire logging
// ---------------------------------------------------------------------------

function logWire(direction: ">>>" | "<<<", line: string) {
  const entry = `${direction} ${line}`;
  if (!QUIET) {
    const parsed = tryParse(line);
    if (parsed) {
      const method =
        parsed.method ??
        (parsed.result
          ? `response:${parsed.id}`
          : parsed.error
            ? `error:${parsed.id}`
            : "?");
      console.log(
        `\x1b[${direction === ">>>" ? "36" : "33"}m${direction}\x1b[0m ${method}`,
      );
      if (parsed.error) {
        console.log(
          `    \x1b[31merror:\x1b[0m ${JSON.stringify(parsed.error)}`,
        );
      }
      if (
        parsed.params?.update?.sessionUpdate &&
        !["agent_message_chunk", "agent_thought_chunk"].includes(
          parsed.params.update.sessionUpdate,
        )
      ) {
        console.log(
          `    update: ${parsed.params.update.sessionUpdate}`,
        );
      }
    } else {
      console.log(entry);
    }
  }
  if (CAPTURE_FILE) {
    appendFileSync(CAPTURE_FILE, entry + "\n");
  }
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function send(proc: ReturnType<typeof spawn>, obj: Record<string, unknown>) {
  const line = JSON.stringify(obj);
  logWire(">>>", line);
  proc.stdin!.write(line + "\n");
}

function sendRequest(
  proc: ReturnType<typeof spawn>,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingPromises.set(id, { resolve, reject, method });
    send(proc, { jsonrpc: "2.0", id, method, params });
  });
}

function sendNotification(
  proc: ReturnType<typeof spawn>,
  method: string,
  params: Record<string, unknown>,
) {
  send(proc, { jsonrpc: "2.0", method, params });
}

// ---------------------------------------------------------------------------
// Response dispatcher
// ---------------------------------------------------------------------------

function handleLine(line: string) {
  logWire("<<<", line);
  const msg = tryParse(line);
  if (!msg) return;

  // Response to our request
  if (typeof msg.id === "number" && pendingPromises.has(msg.id)) {
    const { resolve, reject } = pendingPromises.get(msg.id)!;
    pendingPromises.delete(msg.id);
    if (msg.error) {
      reject(
        new Error(
          `${(msg.error as Record<string, unknown>).message}: ${JSON.stringify((msg.error as Record<string, unknown>).data)}`,
        ),
      );
    } else {
      resolve(msg.result);
    }
    return;
  }

  // Notification from agent
  if (msg.method === "session/update") {
    const update = (msg.params as Record<string, unknown>)?.update as Record<
      string,
      unknown
    >;
    if (!update) return;

    const variant = update.sessionUpdate as string;

    // Collect streaming text for display
    if (variant === "agent_message_chunk" || variant === "agent_thought_chunk") {
      const content = update.content as Record<string, unknown>;
      const text = content?.text as string;
      if (text) {
        const prefix =
          variant === "agent_thought_chunk" ? "\x1b[2m" : "\x1b[0m";
        process.stdout.write(`${prefix}${text}\x1b[0m`);
      }
    }
    return;
  }

  // Incoming request from agent (permissions, elicitations, cursor extensions)
  if (typeof msg.id === "number" && msg.method) {
    handleIncomingRequest(
      msg.id,
      msg.method as string,
      msg.params as Record<string, unknown>,
    );
  }
}

let acpProcess: ReturnType<typeof spawn> | null = null;

function handleIncomingRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  console.log(`\n\x1b[35m← incoming request:\x1b[0m ${method}`);
  console.log(`  params: ${JSON.stringify(params, null, 2)}`);

  // Auto-approve permissions in probe mode
  if (method === "session/request_permission") {
    console.log("  \x1b[32m→ auto-approving\x1b[0m");
    send(acpProcess!, {
      jsonrpc: "2.0",
      id,
      result: { decision: "accept" },
    });
    return;
  }

  // Log and auto-accept elicitations + cursor extensions for capture
  if (
    method === "session/elicitation" ||
    method === "cursor/ask_question" ||
    method === "cursor/create_plan"
  ) {
    console.log(
      `  \x1b[33m→ captured! Sending empty response for schema probing\x1b[0m`,
    );
    send(acpProcess!, { jsonrpc: "2.0", id, result: {} });
    return;
  }

  // fs/terminal stubs
  if (method.startsWith("fs/") || method.startsWith("terminal/")) {
    send(acpProcess!, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `${method} not supported` },
    });
    return;
  }

  // Unknown — log and respond with error
  console.log(`  \x1b[31m→ unknown, responding with -32601\x1b[0m`);
  send(acpProcess!, {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Probe: unhandled ${method}` },
  });
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

async function handshake(proc: ReturnType<typeof spawn>): Promise<string> {
  console.log("\x1b[1m--- Initialize ---\x1b[0m");
  const initResult = (await sendRequest(proc, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "acp-probe", version: "1.0.0" },
  })) as Record<string, unknown>;

  const capabilities = initResult.agentCapabilities as Record<string, unknown>;
  const authMethods = initResult.authMethods as Array<Record<string, unknown>>;
  console.log(
    `  capabilities: ${JSON.stringify(capabilities)}`,
  );
  console.log(
    `  authMethods: ${JSON.stringify(authMethods?.map((m) => m.id))}`,
  );

  const methodId =
    (authMethods?.[0]?.id as string) ?? "cursor_login";
  console.log(`\x1b[1m--- Authenticate (${methodId}) ---\x1b[0m`);
  await sendRequest(proc, "authenticate", { methodId });

  // Load MCP servers if specified
  let mcpServers: unknown[] = [];
  if (MCP_JSON) {
    try {
      const raw = await Bun.file(MCP_JSON).text();
      mcpServers = JSON.parse(raw);
      console.log(`  mcpServers: ${mcpServers.length} loaded from ${MCP_JSON}`);
    } catch (e) {
      console.log(`  \x1b[33mwarning: could not load MCP JSON: ${e}\x1b[0m`);
    }
  }

  console.log("\x1b[1m--- Session/New ---\x1b[0m");
  const sessionResult = (await sendRequest(proc, "session/new", {
    cwd: CWD,
    mcpServers,
  })) as Record<string, unknown>;

  const sid = sessionResult.sessionId as string;
  console.log(`  sessionId: ${sid}`);

  const configOptions = sessionResult.configOptions as Array<
    Record<string, unknown>
  >;
  if (configOptions) {
    for (const opt of configOptions) {
      console.log(
        `  config[${opt.id}]: ${opt.currentValue} (${(opt.options as Array<Record<string, unknown>>)?.length} options)`,
      );
    }
  }

  return sid;
}

// ---------------------------------------------------------------------------
// Interactive commands
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
\x1b[1mACP Probe Commands:\x1b[0m
  /prompt <text>         Send a prompt
  /model <modelId>       Switch model via set_config_option
  /mode <modeId>         Switch mode (agent|plan|ask)
  /cancel                Cancel current prompt
  /load <sessionId>      Load a session
  /config                Show current configOptions
  /raw <json>            Send raw JSON-RPC
  /schema <method>       Probe a method with empty params to get validation errors
  /help                  Show this help
  /quit                  Exit
`);
}

async function handleCommand(
  proc: ReturnType<typeof spawn>,
  input: string,
) {
  const trimmed = input.trim();
  if (!trimmed) return;

  if (trimmed.startsWith("/")) {
    const [cmd, ...rest] = trimmed.split(" ");
    const arg = rest.join(" ");

    switch (cmd) {
      case "/prompt":
      case "/p":
        if (!arg) {
          console.log("Usage: /prompt <text>");
          return;
        }
        console.log("\x1b[1m--- Prompt ---\x1b[0m");
        try {
          const result = await sendRequest(proc, "session/prompt", {
            sessionId: sessionId!,
            prompt: [{ type: "text", text: arg }],
          });
          console.log(`\n\x1b[1mResult:\x1b[0m ${JSON.stringify(result)}`);
        } catch (e) {
          console.log(`\n\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/model":
        if (!arg) {
          console.log("Usage: /model <modelId>");
          return;
        }
        try {
          const result = await sendRequest(proc, "session/set_config_option", {
            sessionId: sessionId!,
            configId: "model",
            value: arg,
          });
          console.log(`Model set. ${JSON.stringify(result)}`);
        } catch (e) {
          console.log(`\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/mode":
        if (!arg) {
          console.log("Usage: /mode <agent|plan|ask>");
          return;
        }
        try {
          const result = await sendRequest(proc, "session/set_mode", {
            sessionId: sessionId!,
            modeId: arg,
          });
          console.log(`Mode set. ${JSON.stringify(result)}`);
        } catch (e) {
          console.log(`\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/cancel":
        sendNotification(proc, "session/cancel", {
          sessionId: sessionId!,
        });
        console.log("Cancel sent.");
        break;

      case "/config":
        try {
          // Re-fetch by setting current value
          const result = (await sendRequest(
            proc,
            "session/set_config_option",
            {
              sessionId: sessionId!,
              configId: "model",
              value: "default[]",
            },
          )) as Record<string, unknown>;
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.log(`\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/load":
        if (!arg) {
          console.log("Usage: /load <sessionId>");
          return;
        }
        try {
          const result = await sendRequest(proc, "session/load", {
            sessionId: arg,
            cwd: CWD,
            mcpServers: [],
          });
          sessionId = arg;
          console.log(`Loaded. ${JSON.stringify(result)}`);
        } catch (e) {
          console.log(`\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/raw":
        if (!arg) {
          console.log('Usage: /raw {"method":"...","params":{}}');
          return;
        }
        try {
          const parsed = JSON.parse(arg);
          const result = await sendRequest(
            proc,
            parsed.method,
            parsed.params ?? {},
          );
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.log(`\x1b[31mError:\x1b[0m ${e}`);
        }
        break;

      case "/schema":
        if (!arg) {
          console.log("Usage: /schema <method>");
          return;
        }
        console.log(`Probing ${arg} with empty params...`);
        try {
          const result = await sendRequest(proc, arg, {});
          console.log(
            `\x1b[32mSuccess:\x1b[0m ${JSON.stringify(result, null, 2)}`,
          );
        } catch (e) {
          console.log(`\x1b[33mValidation:\x1b[0m ${e}`);
        }
        break;

      case "/help":
      case "/h":
        printHelp();
        break;

      case "/quit":
      case "/q":
        console.log("Bye.");
        process.exit(0);

      default:
        console.log(`Unknown command: ${cmd}. Type /help for help.`);
    }
  } else {
    // Bare text = prompt shorthand
    await handleCommand(proc, `/prompt ${trimmed}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (CAPTURE_FILE) {
    writeFileSync(CAPTURE_FILE, `# ACP Probe capture — ${new Date().toISOString()}\n`);
  }

  console.log("\x1b[1m=== ACP Protocol Probe ===\x1b[0m");
  console.log(`  cwd: ${CWD}`);
  if (MODEL) console.log(`  model: ${MODEL}`);
  if (CAPTURE_FILE) console.log(`  capture: ${CAPTURE_FILE}`);

  const proc = spawn("cursor", ["agent", "acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: CWD,
  });
  acpProcess = proc;

  proc.on("exit", (code) => {
    console.log(`\n\x1b[31mCursor process exited (code ${code})\x1b[0m`);
    process.exit(code ?? 1);
  });

  // Process stdout line by line
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete line
    for (const line of lines) {
      if (line.trim()) handleLine(line.trim());
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`\x1b[2mstderr: ${text}\x1b[0m`);
  });

  // Wait a moment for process to start
  await new Promise((r) => setTimeout(r, 500));

  try {
    sessionId = await handshake(proc);
  } catch (e) {
    console.error(`\x1b[31mHandshake failed:\x1b[0m ${e}`);
    proc.kill();
    process.exit(1);
  }

  // Set model if specified
  if (MODEL) {
    console.log(`\x1b[1m--- Set Model (${MODEL}) ---\x1b[0m`);
    try {
      await sendRequest(proc, "session/set_config_option", {
        sessionId: sessionId!,
        configId: "model",
        value: MODEL,
      });
      console.log("  Model set.");
    } catch (e) {
      console.log(`  \x1b[33mwarning: could not set model: ${e}\x1b[0m`);
    }
  }

  // Single prompt mode
  if (INITIAL_PROMPT) {
    console.log("\x1b[1m--- Prompt ---\x1b[0m");
    try {
      const result = await sendRequest(proc, "session/prompt", {
        sessionId: sessionId!,
        prompt: [{ type: "text", text: INITIAL_PROMPT }],
      });
      console.log(`\n\x1b[1mResult:\x1b[0m ${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`\n\x1b[31mError:\x1b[0m ${e}`);
    }
    proc.kill();
    process.exit(0);
  }

  // Interactive mode
  printHelp();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("\x1b[36macp>\x1b[0m ");
  rl.prompt();

  rl.on("line", async (line) => {
    await handleCommand(proc, line);
    rl.prompt();
  });

  rl.on("close", () => {
    proc.kill();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
