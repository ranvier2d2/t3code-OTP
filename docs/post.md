# Why T3Code Might Want Two Runtimes

_Local-first multi-agent desktop apps eventually become supervision problems._

The easy version of this conversation is "pick one runtime." The interesting version is:

> If T3Code wants to be local-first, maybe even local-only, multi-provider, stable under failure, and eventually capable of orchestrating subagents, which runtime should own supervision?

That is the question that matters.

Not "which language is cooler."

Not "which ecosystem is more fun."

Not even "which runtime is faster."

The answer I have landed on is this:

> Elixir becomes compelling when the app stops being "a JavaScript app that opens one coding session" and starts becoming "a supervised tree of local agent runtimes and subagents."
> Node still remains the pragmatic home for adapters, event mapping, desktop integration, and a lot of the surrounding product surface.

> **Note:** This was exercised locally as an architectural experiment. It is not evidence that T3Code has already "moved to Elixir," but instead proposes a discussion inspired by a case-study.

## Quick Take

If you only want the short version, here it is:

- If T3Code stayed mostly Codex-first, desktop-centric, and one-session-at-a-time, I would stay much more Node-first.
- If T3Code grows into a true local multi-agent control plane with subagents, OTP starts solving problems that are structural rather than incidental.
- The most honest answer is not "Elixir instead of Node." It is a clean hybrid boundary.

This is the boundary I would actually defend:

```text
Elixir (supervision + connections)
├── Phoenix Channel WS server
├── Session GenServers (one per provider session)
├── Subagent supervision tree
├── HarnessSnapshot (in-memory read model)
└── Provider process management
    ├── codex (stdio JSON-RPC)
    ├── claude (stdio stream-json)
    ├── cursor (stdio stream-json)
    └── opencode (HTTP + SSE)

          ◄── Phoenix Channel WS ──►

Node (intelligence + UI)
├── HarnessClientAdapter (WS bridge)
├── Canonical event mapping (TS)
├── OrchestrationEngine (event sourcing)
├── Browser/Electron WebSocket
├── SQLite persistence
└── Desktop integration
```

## The Real Problem

T3Code is not trying to be a generic backend that happens to expose a WebSocket.

It is trying to be a local-first, maybe local-only, app that has to manage:

- multiple providers (Codex, Claude, Cursor, OpenCode — each with different transport protocols)
- long-lived sessions
- reconnects and partial streams
- approvals and elicitation
- replay and rebuild
- eventually, subagents

That changes the architecture question.

Once you have several provider processes running locally, each with its own event stream, failure modes, and lifecycle, the job stops looking like "serve some HTTP" and starts looking like "supervise a tree of unstable runtimes."

That is the point where Elixir stops sounding like a side quest.

## What Elixir Actually Makes Better

The best case for Elixir is not generic throughput. It is not "the BEAM is cool." It is that OTP maps unusually well to the shape of this problem.

### 1. Session isolation stops being a convention

Each provider session is already its own unstable thing:

- a Codex app-server process speaking JSON-RPC over stdio
- a Claude runtime process speaking stream-json over stdio
- a Cursor Agent process with two possible protocols: ACP (JSON-RPC with structured session management) or stream-json (simpler but stateless per turn)
- an OpenCode HTTP server with SSE event streaming

In OTP, each of those naturally becomes its own GenServer with its own mailbox, lifecycle, and restart boundary.

That matters because:

- one broken session does not poison siblings
- one degraded provider does not imply global instability
- one noisy or memory-heavy path is contained to its own process heap

This is the single strongest pro-Elixir argument.

### 2. Supervision trees look like the product

A local agent app increasingly looks like a supervision tree already:

```text
App
  -> Workspace
    -> Session
      -> Turn
      -> Connector
      -> Subagent
```

And once subagents are real, the fit gets even tighter:

```text
Thread
  -> Parent session (GenServer)
    -> Subagent A (GenServer → codex process)
    -> Subagent B (GenServer → opencode serve)
    -> Subagent C (GenServer → claude process)
```

At that point, "start child," "monitor child," "restart child," and "stop subtree" are not just architecture words. They are the product.

### 3. Concurrent waiting becomes normal

These apps spend a surprising amount of time waiting:

- provider stream open
- approval pending
- elicitation pending
- connector degraded
- replay rebuilding
- one subagent idle while another streams

OTP treats "many small independent things waiting at the same time" as normal. Node can do this too, but it usually does it by discipline. OTP does it by default.

### 4. Per-process heaps quietly matter

Long-lived local tools accumulate state: stream buffers, replay buffers, tool outputs, pending approvals, subagent histories.

In the BEAM, each process owns its heap and its garbage collection. A badly behaved session is contained to its own process and less likely to make the whole app feel softer after a few hours of use.

We tested this directly. A simulated memory leak (50KB deltas, never completing) ran alongside 3 healthy sessions for 2 minutes:

![Memory Leak Isolation](output/stress-test/charts/memory-leak-divergence.png)

Node's shared V8 heap grew to 2,800% of its baseline (5MB → 158MB), with event loop lag spiking to 169ms p99. Elixir's BEAM total memory stayed at 102% of baseline — the leaky process oscillated 94-352KB while healthy sessions were completely unaffected. Both completed all 27 healthy turns.

### 5. Subagents make the argument much stronger

If T3Code stayed a one-agent-at-a-time tool, I would not push hard for Elixir.

Subagents change the math. They intensify:

- parent-child cancellation
- partial failure handling
- concurrent approvals across siblings
- concurrent streams from different providers
- nested delegation
- tree cleanup on parent abort

OTP stops feeling like architecture taste and starts feeling like the native operating model.

## What Elixir Does Not Fix

This is where we need to be disciplined.

Introducing Elixir does **not** make Node disappear.

T3Code is still a TypeScript-shaped product:

- React frontend
- desktop shell concerns
- JS-native provider ecosystem
- local tooling integration
- adapter and event mapping logic (thousands of lines of TypeScript)

So the honest question is not "would Elixir be nice?"

It is:

> Is the supervision problem important enough to justify carrying a second runtime?

### Provider SDKs are npm packages

`@anthropic-ai/claude-agent-sdk` is a Node package. Julius's Claude adapter imports the SDK and uses its `query()` function directly — no bridge, no serialization, no second process. If a future provider SDK only offers a programmatic JS API with no CLI, Elixir cannot consume it natively.

Today the harness spawns provider binaries (`claude`, `codex`, `cursor`, `opencode`), which is equivalent. But the SDK path is simpler when it exists.

This extends to protocol choices too. Julius's Cursor adapter (PR #178) uses ACP — a JSON-RPC protocol that provides structured authentication, session persistence, and permission negotiation. Our harness uses `--print --output-format stream-json`, which is simpler but stateless per turn. For production, ACP is likely the right choice for Cursor specifically, and it requires Node to speak JSON-RPC directly — not spawn a process and parse stdout.

It is also worth noting that Codex CLI has been rewritten in Rust — using OS-level sandboxing (Seatbelt on macOS, Landlock+seccomp on Linux) for deterministic isolation. OpenAI chose to leave the JavaScript ecosystem entirely for the runtime layer. This is not evidence for Elixir specifically, but it is evidence that the industry is finding Node insufficient for agent process management at the level where isolation matters.

### TypeScript types are the contract

The 46 `ProviderRuntimeEvent` types, the `OrchestrationCommand` schemas, the `WsPush` envelopes — all defined in TypeScript with Effect Schema. Event mapping (raw provider events to canonical types) is inherently a TypeScript problem because the types live there. Moving that to Elixir would mean duplicating or generating schemas across languages.

The 1,235-line `codexEventMapping.ts` and the 2,912-line `ClaudeAdapter.ts` are evidence: the intelligence layer is TypeScript-shaped regardless of where supervision lives.

### Electron is Node

Electron already bundles Node. The T3Code server runs as a child process inside Electron. Adding BEAM means spawning a second runtime, managing its lifecycle, and bundling it for macOS (arm64 + x64), Windows, and Linux. That is 50-100MB of additional binary size and another failure surface on user machines.

This is not ideological friction. It is shipping friction.

### The shared event loop is a real advantage

When the OrchestrationEngine receives an event, it persists to SQLite, updates the in-memory read model, and pushes to the browser — all in the same tick, zero serialization. With the harness, there is an extra hop: Elixir GenServer → Phoenix Channel → Node WebSocket → Effect Queue → OrchestrationEngine. That hop adds ~1ms and a failure mode (bridge disconnect).

For most operations that latency is invisible. But the failure mode is real: if the bridge drops during a streaming turn, events are lost until reconnection.

### One debugger, one stack trace

When something fails in Node, you get a continuous stack trace. With the harness, an error can start in Elixir (GenServer crash), manifest in Node (bridge disconnect), and surface in the browser (events stop). Debugging across two runtimes with two log systems is objectively harder.

### A bad hybrid is worse than a good single-runtime design

If the ownership boundary is vague, you get two runtimes, unclear authority, bridge complexity, and duplicated failure modes.

So if Elixir enters the picture, the boundary cannot be hand-wavy. It has to be sharp.

It is worth noting that others have tried to build actor-based supervision on top of existing VMs. Akka brought supervision trees and location-transparent actors to the JVM. Microsoft Orleans brought virtual actors to .NET. Both required massive engineering effort to approximate what the BEAM provides natively — and both prove that the pattern is valuable enough that teams will invest years to recreate it. The question for T3Code is not whether supervision trees are useful (the industry has answered that), but whether the BEAM's native implementation justifies the cost of a second runtime versus building a lighter approximation in Node.

## The Boundary I Would Actually Defend

| Area                            | Best owner |
| :------------------------------ | :--------- |
| Session + subagent supervision  | Elixir     |
| Provider connection management  | Elixir     |
| Harness event streaming         | Elixir     |
| In-memory read model (snapshot) | Elixir     |
| Canonical event mapping         | Node       |
| Provider adapter logic          | Node       |
| SQLite persistence              | Node       |
| Browser/Electron WebSocket      | Node       |
| Desktop + product integration   | Node       |

The key point is simple:

> The best use of Elixir here is not "replace Node."
> It is "own the process tree."

## What the Local Experiments Actually Showed

This is where I want to stay disciplined, because architecture writing becomes dishonest very quickly when it starts claiming more than the repo really proves.

### What we verified end-to-end

All four providers ran through the Elixir harness with real prompts returning real responses:

| Provider | Transport                         | E2E Verified | What works in the browser                                                                                                                                                       |
| -------- | --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | stdio stream-json via `/bin/sh`   | Yes          | Text streaming, reasoning, tool use (Glob, Read, etc.), sidebar states, session lifecycle                                                                                       |
| Codex    | stdio JSON-RPC via Erlang Port    | Yes          | Text streaming, reasoning, tool execution (shell commands), tool output, sidebar states, subagent collaboration                                                                 |
| Cursor   | stdio stream-json via Erlang Port | Yes          | Text streaming, reasoning lifecycle, auto-classified tools (Glob, Shell, etc.), 80+ discovered models, sidebar Connecting→Working→Completed, session persistence via `--resume` |
| OpenCode | HTTP + SSE via raw TCP + Req      | Yes          | Text streaming, reasoning phase separation, tool use, 18 discovered models, sidebar states, approval flow                                                                       |

The full pipeline:

```text
Node WS client
  → Phoenix Channel (join "harness:lobby")
    → SessionManager routes to GenServer
      → GenServer spawns provider process
        → Provider streams events back
          → SnapshotServer projects into HarnessSnapshot
            → PubSub broadcasts
              → Channel pushes to Node
```

Along the way, we hit and solved real implementation problems:

- Erlang Ports with the `{:line, N}` option deliver output as structured `{:eol, line}` tuples (complete lines) or `{:noeol, partial}` (lines exceeding N bytes). Without `:line`, ports deliver raw binary chunks regardless of spawn method. The `{:spawn_executable, path}` mode is preferred over `{:spawn, cmd}` for security — no shell interpretation, explicit argument handling via `{:args, [...]}`. Every GenServer must handle both message shapes depending on port configuration.
- Claude's `--print` mode reads stdin by default, causing a 3-second hang. Fix: spawn via `/bin/sh -c "... < /dev/null"`.
- Codex uses internal UUIDs for thread IDs, not our harness IDs. Must capture from `thread/start` response.
- Cursor needs `--stream-partial-output` or it buffers all output until the turn completes — zero events during processing. Also needs `--trust` for headless workspace trust.
- OpenCode's SSE uses chunked transfer encoding that neither `:httpc` nor Req deliver reliably for streaming. Raw `:gen_tcp` with regex extraction of `data: {json}` patterns works.
- OpenCode signals turn completion via `session.idle` SSE event, not `message.updated` with a `finish` field. Missing this means turns never "complete" in the UI.
- Content delta events need `turnId` in the payload. Without it, the ingestion layer creates a separate assistant message per delta (each gets a unique ID from `event.eventId` fallback). This was the root cause of text not rendering for Cursor and OpenCode.
- Codex nests `turnId` in `payload.msg.turn_id` (JSON-RPC notification params), not at the top level. The bridge must check nested paths.
- `item/completed` events must not default to `assistant_message` type — Codex sends `item/completed` for reasoning, user messages, and tool calls. Defaulting to `assistant_message` creates phantom "(empty response)" messages.
- Background processes (like SSE listeners) must use `spawn` + `Process.monitor`, not `spawn_link`, to prevent crash cascading to the parent GenServer.

Those are not theoretical findings. They are the kind of things you only learn by running real provider processes through a real supervision tree.

The harness includes a CLI (`bin/harness`) that can start all four providers, run a dry-run across them, query the live snapshot, and manage sessions — a full local control plane in a single command.

### Concurrent session ramp — the OOM challenge

We built a geometric session ramp test that scales real provider sessions from 4 to 200 through the Elixir harness, with each turn requiring actual tool usage (bash commands). On an 8GB MacBook Air, the system cleanly sustained 35 concurrent sessions (7 per provider × 4 providers + 7 mock control) with 100% completion rate and zero errors.

| Step | Sessions | Completed | p50   | p99   | BEAM Memory | SnapshotServer Queue |
| ---- | -------- | --------- | ----- | ----- | ----------- | -------------------- |
| 1    | 5        | 5 (100%)  | 11.5s | 12.3s | 52→57MB     | 0                    |
| 2    | 25       | 25 (100%) | 4.0s  | 25.3s | 56→69MB     | 74                   |
| 3    | 35       | 35 (100%) | 13.3s | 39.3s | 62→81MB     | 790                  |
| 4    | 50       | skipped   | —     | —     | —           | (memory guard)       |

A key discovery: **Codex is the natural infrastructure canary.** Its single long-lived `codex app-server` process maintains stable p50 latency (2-8s) across all concurrency levels, while Claude and Cursor vary 4x between runs (25-100s) due to CLI spawn overhead. When Codex degrades, it signals harness saturation — not provider slowness. We replaced our initial p99 latency stop condition (which incorrectly measured provider TTFT, not harness health) with BEAM telemetry-based signals: SnapshotServer queue depth, Codex degradation ratio (`current_p50 / baseline_p50` — a ratio >2.0 indicates infrastructure saturation rather than provider slowness, computed from Codex service response times since its long-lived process eliminates spawn overhead as a variable), infrastructure error detection (`:emfile`), and memory growth.

The 35-session ceiling is hardware-limited (8GB RAM), not BEAM-limited. BEAM memory per session is negligible (~268KB), but each provider CLI process consumes ~150-200MB of out-of-BEAM OS memory (Node/Python runtimes, model context buffers), so 35 sessions × ~200MB saturates the 8GB machine. BEAM scheduler utilization was 0.76% at peak — the runtime has enormous headroom. On a 32GB machine, the architectural ceiling would be the SnapshotServer throughput, not memory.

### Tool use — not just "say hello"

The providers do not just answer text prompts. They execute tools through the harness in full-access mode:

| Provider | Tool executed       | Result               | Auto-approval mechanism                                  |
| -------- | ------------------- | -------------------- | -------------------------------------------------------- |
| Codex    | `commandExecution`  | File created on disk | `approvalPolicy:"never"`, `sandbox:"danger-full-access"` |
| Cursor   | file write          | File created on disk | `--force` flag                                           |
| Claude   | file write          | File created on disk | `--permission-mode bypassPermissions`                    |
| OpenCode | `file_change write` | File created on disk | `reply_to_permission("always")` on `permission.asked`    |

Each provider has a different approval mechanism, but the harness handles all of them. In full-access mode, tools execute without user intervention — the same behavior as the native adapters.

### Crash isolation — the structural argument

This is where the OTP argument moves from theoretical to concrete.

We ran a crash isolation proof: two concurrent sessions (Codex and Claude) processing tasks simultaneously through the Elixir harness. Mid-stream, one session was killed via `DynamicSupervisor.terminate_child`. The result:

```
🔴 Session A (Codex):
   Turn started: true
   Killed: true
   Completed after kill: false

🟢 Session B (Claude):
   Turn started: true
   Completed: true
   Response: "The tide pulls back like a held breath..."
```

Session A was terminated. Session B completed its poem independently, unaware that its sibling had crashed. No shared state corruption, no event stream contamination, no cascading failure.

This is the difference between structural and behavioral isolation. Process isolation is robust but not magical — ETS tables are destroyed when their owner crashes (mitigated via `{:heir, pid, data}`), named processes leave a brief registration gap during restart, and shared Ports close when their owner dies. These are well-understood patterns with standard OTP mitigations, but they mean "isolation" is architectural, not absolute. In a single-threaded Node runtime, killing one session's processing requires careful cleanup to ensure nothing leaks into the shared event loop, shared memory, or shared callback chains. In OTP, each GenServer is its own BEAM process with its own heap — terminating one is a no-op for its siblings by construction, not by discipline.

We scaled this test to 6 concurrent sessions: 1 victim (crashes after 10 deltas) and 5 survivors (200 deltas each). Both runtimes passed — all 5 survivors completed with full output, and all continued receiving events after the crash. In Elixir, the DynamicSupervisor automatically cleaned up the crashed session (6 → 5 active sessions). In Node, this requires manual Map cleanup and error handling.

This does not mean Node cannot achieve the same result. It can. But in OTP, isolation is the default. In Node, isolation is a discipline.

### What would be misleading to claim

- T3Code has moved to Elixir (it has not)
- Elixir has replaced Node (Node still owns all the intelligence)
- The OTP path is production-landed (it is a local prototype)

The right sentence is still:

> This was exercised locally as an architectural experiment, with real provider processes producing real responses through the Elixir harness.

### What the diff actually looks like

The total diff against the upstream `main` branch is 94 commits, 66 production files changed, +10,618 / -1,466 lines. The harness adds ~5,300 lines of Elixir to a ~76,000-line TypeScript codebase — roughly 7% of total production code.

| Category           | Files       | Lines    | Nature                                                                                    |
| ------------------ | ----------- | -------- | ----------------------------------------------------------------------------------------- |
| Elixir harness     | 35          | ~6,500   | Entirely new (`apps/harness/`), does not exist on main                                    |
| Node bridge        | 3 new       | ~3,100   | `HarnessClientAdapter` (1,096), `HarnessClientManager` (586), `codexEventMapping` (1,375) |
| Node modifications | 17 existing | ~500 net | config, serverLayers, ProviderCommandReactor, ProviderHealth, GitCore                     |
| Web UI             | 10          | ~550 net | Model picker, sidebar states, session logic, composer registry                            |

Each provider GenServer is a self-contained adapter:

| Provider | Transport                         | GenServer LOC | Features implemented                                                                                                                    |
| -------- | --------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | stdio stream-json via `/bin/sh`   | 1,001         | Streaming, reasoning, tool lifecycle, approval, user input, session state                                                               |
| Cursor   | stdio stream-json via Erlang Port | 816           | Streaming, reasoning lifecycle, auto-classified tools (11 known + dynamic), session persistence via `create-chat`/`--resume`, yolo mode |
| OpenCode | HTTP + SSE via raw TCP + Req      | 1,092         | Streaming, reasoning phase tracking, tool lifecycle, approval, user input, permission auto-approve, model discovery                     |
| Codex    | stdio JSON-RPC via Erlang Port    | 597           | Full JSON-RPC 2.0 (request/response/notification), approval, user input, subagent collaboration events                                  |
| Mock     | In-memory simulation              | 319           | Configurable delays, failures, tool output — used by stress tests                                                                       |

All four providers now have **full UI feature coverage** through the harness:

| UI Feature                                  | Claude | Cursor    | OpenCode | Codex |
| ------------------------------------------- | ------ | --------- | -------- | ----- |
| Sidebar: Connecting → Working → Completed   | ✅     | ✅        | ✅       | ✅    |
| Chat: assistant text streaming              | ✅     | ✅        | ✅       | ✅    |
| Chat: reasoning/thinking (separated)        | ✅     | ✅        | ✅       | ✅    |
| Work log: tool started/completed with names | ✅     | ✅        | ✅       | ✅    |
| Work log: tool output streaming             | ✅     | ✅        | ✅       | ✅    |
| Approval requests                           | ✅     | ✅ (yolo) | ✅       | ✅    |
| Dynamic model discovery                     | N/A    | ✅ (80+)  | ✅ (18)  | N/A   |
| Token usage                                 | ✅     | ✅        | ✅       | ✅    |
| Error display                               | ✅     | ✅        | ✅       | ✅    |
| Session persistence / multi-turn            | ✅     | ✅        | ✅       | ✅    |

The Elixir harness is additive — it does not delete or replace any existing Node code. The Node modifications are surgical: wiring the new adapter, extracting event mapping logic for reuse, adding 4-provider support to health checks, and mapping Codex raw events to the canonical runtime event algebra. The web UI changes were minimal but impactful: sidebar state badges, model picker with discovered models, and session lifecycle alignment.

After merging the latest main, the branch compiles clean with zero TypeScript errors, zero Elixir warnings, and all 19 Elixir tests passing.

## The Tradeoff in One Table

| Dimension             | Elixir/OTP                           | Node/TypeScript                            |
| :-------------------- | :----------------------------------- | :----------------------------------------- |
| Session supervision   | Native fit                           | Possible, but more manual                  |
| Failure isolation     | Structural (BEAM processes)          | Behavioral (requires explicit boundaries)  |
| Subagent trees        | DynamicSupervisor.start_child        | Manual cleanup chains                      |
| Per-process heaps     | Independent heaps, independent GC    | Shared V8 heap, coupled memory growth      |
| Adding a new provider | 597-1,092 lines GenServer (measured) | ~2,000-3,000 lines adapter                 |
| Desktop packaging     | Adds 50-100MB BEAM runtime           | No additional overhead                     |
| JS-native ecosystem   | Weaker (must spawn as processes)     | Stronger (can import as packages)          |
| Event mapping         | Stays in TypeScript                  | Stays in TypeScript                        |
| Hybrid risk           | Can split if boundary is vague       | Avoids dual runtime, centralizes more risk |

## Why Subagents Change the Calculus

This is the section where my opinion becomes less neutral.

Subagents are the breakpoint.

Imagine a future session like this:

```text
Parent task
  -> Codex subagent for implementation
  -> OpenCode subagent for search
  -> Claude subagent for synthesis
```

Now ask the annoying questions:

- What happens if one subagent crashes mid-turn?
- What happens if one subagent is blocked on approval while another keeps streaming?
- What happens if the parent cancels and all children must stop cleanly?
- What happens if one child leaks memory or gets wedged on reconnect?

A Node-only architecture can answer them, but it answers them behaviorally: careful process accounting, careful cleanup chains, careful shared-state discipline.

OTP gives you a stronger starting point because it already assumes the world is made of many small, failure-prone processes that need supervision. Each subagent is a GenServer under a DynamicSupervisor. Parent crash cascades to children via process links. One child's memory leak is contained to its own heap. Restart policies are declarative, not imperative.

That is why subagents materially strengthen the pro-Elixir case.

There is a deeper reason OTP fits here. AI agents are inherently non-deterministic — LLM calls return different results every time, tool calls fail unpredictably, rate limits hit without warning, context windows overflow, and models hallucinate invalid JSON. You cannot enumerate all failure modes in advance. This is the exact class of problem OTP's "let it crash" philosophy was designed for: instead of wrapping every call in defensive error handling, you write the happy path and let the supervisor handle recovery. Each subagent GenServer crashes, restarts in a clean state, and its siblings continue unaffected. The more autonomous and unpredictable agents become, the stronger this argument gets.

## The Core Team Is Already Building This — in Node

After completing the Elixir harness, I discovered that the T3Code core team has an open draft PR (#581) titled "Centralize all harnesses with single websocket server." It is remarkably similar to what we built.

PR #581 introduces:

- A `HarnessService` with event listeners and snapshot projection
- A `HarnessAdapter` interface with `createSession`, `sendTurn`, `cancelTurn`, `resolvePermission`, `resolveElicitation`, `streamEvents`
- A `HarnessMemoryStore` for in-memory state
- Three adapters: codex (JSON-RPC), claude (via `claude-agent-sdk`), opencode (HTTP+SSE)
- An event projector that builds a `HarnessSnapshot` from events

This is the same architecture. Same adapter pattern, same event projection, same session management abstraction. The difference is that it is written entirely in TypeScript.

This changes the conversation in an important way. The question is no longer "could Node do this?" — it clearly can, and the core team is already doing it. The question becomes: at what scale of concurrent sessions, subagent trees, and failure isolation does the structural advantage of OTP justify a second runtime?

That is a harder question to answer. So we measured it.

## The Crossover Benchmarks

To answer "at what scale?" with data instead of intuition, we built a benchmark suite: 5 scaling sweeps that vary a single parameter across a range, measuring both runtimes under identical conditions. Each benchmark uses the mock provider (configurable deltas, no API calls) for reproducibility, runs 3 times per step (taking the median), and collects metrics at 1-second intervals.

The question each benchmark answers is the same: **where does Node degrade while Elixir stays stable?**

![OTP Crossover Benchmark Suite: The Full Picture](output/stress-test/charts/crossover-summary.png)

### Session Count Ramp — the headline chart

We scaled concurrent sessions from 5 to 200, all streaming simultaneously (100 × 1KB deltas per session).

| Sessions | Node P99 Latency | Elixir P99 Latency | Node Throughput | Elixir Throughput | Node Event Loop Lag P99 |
| -------- | ---------------- | ------------------ | --------------- | ----------------- | ----------------------- |
| 5        | 1,123ms          | 1,124ms            | 445 ev/s        | 445 ev/s          | —                       |
| 10       | 1,169ms          | 1,119ms            | 855 ev/s        | 894 ev/s          | —                       |
| 20       | 1,171ms          | 1,110ms            | 1,708 ev/s      | 1,800 ev/s        | —                       |
| 50       | 1,170ms          | 1,100ms            | 4,244 ev/s      | 4,529 ev/s        | 5.6ms                   |
| 100      | 1,206ms          | 1,120ms            | 7,949 ev/s      | 8,621 ev/s        | 27.3ms                  |
| 150      | 1,605ms          | 1,486ms            | 8,782 ev/s      | 9,053 ev/s        | **199.4ms**             |
| **200**  | **3,314ms**      | **607ms**          | **5,779 ev/s**  | **18,000 ev/s**   | **1,209ms**             |

![Session Count Ramp: Latency and Throughput](output/stress-test/charts/crossover-session-ramp.png)

The crossover is dramatic. From 5 to 100 sessions, both runtimes perform similarly — Node's event loop lag creeps up but stays manageable. At 150, the first signs appear (199ms lag). At **200 sessions, Node collapses**: latency jumps to 3.3 seconds, throughput _drops_ from its peak (the event loop is so saturated that it processes fewer events, not more), and event loop lag hits 1.2 seconds.

Meanwhile, Elixir at 200 sessions: 607ms latency (5.5x better), 18,000 events/sec (3.1x better), **0.0% scheduler utilization**, and a constant ~268KB per session across every step from 5 to 200.

The BEAM does not even notice the load.

100% correctness at every step, both runtimes. No events lost. The difference is purely in how the runtimes handle the concurrency.

![Node Event Loop Lag: The Saturation Curve](output/stress-test/charts/crossover-event-loop-lag.png)

### Payload Size Ramp — the noisy neighbor test

We ran 1 heavy session (500 deltas at variable size) alongside 5 light sessions (100 × 0.1KB deltas), scaling the heavy payload from 0.1KB to 500KB.

| Heavy Payload | Node Light Latency P99 | Elixir Light Latency P99 | Node Throughput | Elixir Throughput |
| ------------- | ---------------------- | ------------------------ | --------------- | ----------------- |
| 0.1KB         | 1ms                    | 2ms                      | 860 ev/s        | 898 ev/s          |
| 10KB          | 1ms                    | 3ms                      | 898 ev/s        | 910 ev/s          |
| 100KB         | 1ms                    | 2ms                      | 905 ev/s        | 925 ev/s          |
| 500KB         | 1ms                    | 3ms                      | 378 ev/s        | 315 ev/s          |

![Payload Size Ramp: Noisy Neighbor Test](output/stress-test/charts/crossover-payload-ramp.png)

Surprise: **no significant noisy-neighbor effect at these scales.** Both runtimes isolated light sessions from the heavy session effectively. Node's shared event loop handled the JSON parsing without degrading siblings. At 500KB, both runtimes slowed down (the pipe bandwidth becomes the bottleneck, not the runtime). The crossover for payload size would require combining large payloads _with_ high session counts — which is exactly what happens in production when multiple providers stream simultaneously.

### Subagent Tree Width Ramp — the orchestration test

We scaled parent sessions (each spawning 3 subagents via the mock provider's `subagent` mode) from 1 to 30 parents (3 to 90 subagents).

| Parents | Subagents | Node Throughput | Elixir Throughput | Node Integrity | Elixir Integrity | Fairness σ |
| ------- | --------- | --------------- | ----------------- | -------------- | ---------------- | ---------- |
| 1       | 3         | 170 ev/s        | 158 ev/s          | 100%           | 100%             | 0          |
| 5       | 15        | 870 ev/s        | 800 ev/s          | 100%           | 100%             | 0          |
| 10      | 30        | 1,744 ev/s      | 1,753 ev/s        | 100%           | 100%             | 0          |
| 20      | 60        | 3,434 ev/s      | 3,478 ev/s        | 100%           | 100%             | 0          |
| 30      | 90        | 5,062 ev/s      | 5,062 ev/s        | 100%           | 100%             | 0          |

![Subagent Tree Width: Orchestration at Scale](output/stress-test/charts/crossover-subagent-ramp.png)

Both runtimes scale linearly and identically up to 90 subagents. 100% lifecycle integrity (every `spawn_begin` has a matching `spawn_end`, every `interaction_begin` has a matching `interaction_end`). Zero fairness deviation — no session starved. At this scale, the mock protocol is fast enough that neither runtime's event routing becomes a bottleneck. The divergence would appear with real providers, where each subagent involves actual LLM calls, file I/O, and unpredictable latencies.

### Failure Storm — the resilience test

We ran 30 sessions simultaneously, with K crash victims (using the mock `crash` mode: emit 10 deltas then `process.exit(1)`), sweeping K from 0 to 20.

| Crashes | Survivors | Correctness | Node Lag Spike | Elixir Lag Spike | Node Errors | Elixir Errors |
| ------- | --------- | ----------- | -------------- | ---------------- | ----------- | ------------- |
| 0       | 30        | 100% / 100% | 0.0ms          | 0.0ms            | 0           | 0             |
| 1       | 29        | 100% / 100% | 2.1ms          | **0.0ms**        | 0           | 0             |
| 5       | 25        | 100% / 100% | 2.6ms          | **0.0ms**        | 0           | 0             |
| 10      | 20        | 100% / 100% | 2.7ms          | **0.0ms**        | 0           | 0             |
| 20      | 10        | 100% / 100% | 1.4ms          | **0.0ms**        | 0           | 0             |

![Failure Storm: Crash Impact on Survivors](output/stress-test/charts/crossover-failure-storm.png)

Both runtimes achieve 100% survivor correctness and zero errors across all crash intensities. The difference is structural: **Elixir shows 0.0ms lag spike at every crash count.** Node shows a small but consistent spike (1.4–2.7ms) because crash cleanup (file descriptor closure, readline teardown, Map deletion) runs synchronously on the event loop. At this scale, the spike is negligible. But it is non-zero — and it would compound with larger session counts and heavier workloads.

This is the "isolation by construction vs. isolation by discipline" argument, made visible in data.

### Sustained Leak — the long-running stability test

We ran one leaking session (50KB deltas every 50ms, never completing) alongside M healthy sessions for 5 minutes per variant.

| Healthy Sessions | Node Memory Growth | Elixir Memory Growth | Node Lag P99 | Elixir Per-Session Memory |
| ---------------- | ------------------ | -------------------- | ------------ | ------------------------- |
| 1                | +19.3MB (713%)     | +23.7MB (37%)        | 14.3ms       | 261KB                     |
| 5                | +10.8MB (284%)     | flat                 | 60.8ms       | 278KB                     |
| 10               | flat               | +7.5MB (13%)         | 37.8ms       | 266KB                     |
| 20               | flat               | +8.1MB (13%)         | 20.0ms       | 251KB                     |

![Sustained Leak: Memory Growth Over 5 Minutes](output/stress-test/charts/crossover-sustained-leak.png)

The percentage growth tells the story: Node's baseline is small (~2.7MB heap), so even moderate accumulation looks like 713% growth. Elixir's baseline includes the entire BEAM VM (~64MB), making percentages smaller. The absolute numbers matter more: Node's V8 GC aggressively reclaims at higher healthy-session counts (the GC pressure from healthy sessions triggers collection that cleans up the leak residue). Elixir's leak process grows independently but the healthy sessions stay at ~260KB each, completely unaffected.

The event loop lag is the more telling metric: Node peaks at 60.8ms with 5 healthy sessions. Elixir has no equivalent single-threaded bottleneck.

### What the benchmarks prove — and what they do not

**They prove:**

- The session count crossover is real and occurs at **~150-200 concurrent sessions.** Below 100, both runtimes are functionally equivalent. Above 150, Node's single event loop becomes the bottleneck.
- Elixir's per-process architecture makes crash impact **structurally zero** — not just "low" but literally 0.0ms at every tested crash intensity.
- Elixir maintains **constant ~268KB per session** from 5 to 200 sessions with 0% scheduler utilization. It does not even register the load.
- Both runtimes achieve **100% correctness** at every scale tested. No events lost, no sessions corrupted.

**They do not prove:**

- That the crossover matters for T3Code's current use case (1-5 sessions). It does not. At that scale, Node is identical.
- That payload size causes noisy-neighbor effects. At tested scales (up to 500KB), both runtimes isolate well.
- That subagent routing becomes a bottleneck. Up to 90 mock subagents, both runtimes scale linearly. Real providers with real latencies may tell a different story.

The honest conclusion: **the OTP advantage is real but scale-dependent.** It materializes at a concurrency level (100+ simultaneous agent sessions) that T3Code does not reach today but would reach as a multi-agent orchestrator with subagent trees.

---

If T3Code stays a tool where one user opens one session at a time, PR #581's Node approach is simpler, cheaper to ship, and more maintainable. No second runtime, no bridge, no packaging cost.

If it grows into a local control plane with concurrent subagent trees — the kind of system where one parent session supervises five child agent processes across three providers — then the structural guarantees of OTP (process isolation, supervision trees, per-process GC, linked crash cascading) start earning their keep. And the benchmarks show exactly where that line is.

The prototype we built proves both sides: the patterns work in Elixir _and_ they work in Node. The difference is not in what is possible. It is in what becomes the default.

## I Ran a Structured Multi-Perspective Review

I did not want this to read like "I like OTP, therefore OTP wins."

So I ran a structured multi-perspective review using AI agents assigned to challenge the framing from different angles: one argued the strongest case for OTP, one argued the strongest case for staying Node-first, and one argued the strongest case for not overstating what the repo actually proves.

That changed the piece in useful ways.

### Best argument for OTP

> If the system becomes a tree of unstable local runtimes, OTP is not a fancy optimization. It is the native operating model.

### Best argument for staying Node-first

> If you do not actually get to delete Node, then Elixir is a second runtime, not a replacement runtime, and that cost must be justified.

That objection is healthy. It is why the honest conclusion is not "rewrite T3Code in Elixir."

### Best warning against overstating the experiment

> Do not claim more than the experiment actually proved.

The local experiments are meaningful — four providers, real responses, real streaming. They are not the same thing as a finished migration.

## So, Should T3Code Use Elixir Instead of Node?

Two questions keep this honest:

**"What concrete failures become simpler in OTP?"** — If the answer is vague, Elixir is aesthetic preference. It becomes compelling when it cashes out into session isolation, subagent trees, cancellation cascades, and concurrent blocked workflows.

**"What existing Node responsibilities actually disappear?"** — Almost none. Event mapping, adapter logic, desktop integration, SQLite writes — all stay. The win is clarified ownership, not deletion of Node.

So I would not argue for replacing the whole backend or pretending the JS ecosystem no longer matters.

## Nobody Else Has Solved This Either

In February 2026, George Guimarães published "Your Agent Framework Is Just a Bad Clone of Elixir" — arguing that every pattern Python agent frameworks are building (isolated state, message passing, supervision hierarchies, fault recovery) has existed in BEAM/OTP since 1986. The post went viral for good reason: it named something the ecosystem had been dancing around.

Looking at every major agent framework confirms the pattern:

| Framework         | Runtime                | Process isolation               | Failure handling              |
| ----------------- | ---------------------- | ------------------------------- | ----------------------------- |
| OpenAI Agents SDK | Python asyncio         | None — shared event loop        | Manual try/except             |
| LangGraph         | Python asyncio         | None — thread_id namespace only | Checkpointing (best in class) |
| CrewAI            | Python asyncio         | None                            | Hierarchical delegation       |
| AutoGen           | Python + optional gRPC | gRPC workers (experimental)     | Documented exception issues   |
| Mastra            | Node.js event loop     | None                            | Workflow suspend/resume       |

None chose BEAM. None achieved process-level isolation. The reason is ecosystem gravity — Python dominates ML/AI, and LLM provider SDKs are Python/Node-first. But the supervision gap is real, and it grows as agent systems become more autonomous.

T3Code sits at an interesting intersection: it already orchestrates across providers with heterogeneous protocols, and it already spawns real OS processes per session. PR #581 proves the patterns work in Node. The question is whether the _execution guarantees_ justify a second runtime — and that question gets louder as subagent trees deepen.

(See: George Guimarães, "Your Agent Framework Is Just a Bad Clone of Elixir," February 2026. He also published a follow-up addressing valid criticisms from Hacker News — "Elixir/BEAM Doesn't Solve Everything for AI Agents" — which honestly names the gaps in the BEAM ecosystem for AI: immature LLM tooling compared to Python, smaller talent pool, and the reality that most AI provider SDKs are Python/Node-first. Those gaps are real and relevant to T3Code's decision.)

## Appendix: Failure Scenario Analysis

After building both approaches, I compared them across ten concrete failure scenarios. Not benchmarks — failure scenarios. Because the OTP argument is not about throughput. It is about what happens when things go wrong.

| #   | Scenario                         | Node (main)                                     | Elixir (harness)                                     | Winner     | Tested?                        |
| --- | -------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------ |
| 1   | Provider CLI hangs               | Session context stale, others unaffected        | GenServer stale, others unaffected                   | Tie        | —                              |
| 2   | Provider CLI crashes             | `child.on("exit")` cleans up, others continue   | Port exit handled, others continue                   | Tie        | **Yes** — crash isolation test |
| 3   | Memory leak in one session       | Leak grows shared heap (+145MB), lag +169ms p99 | Leak bounded per-process (94-352KB), others flat     | Elixir     | **Yes** — memory leak test     |
| 4   | Unhandled exception in callback  | 5/5 survivors continue (child process crash)    | 5/5 survivors continue (GenServer cleanup)           | Tie\*      | **Yes** — exception injection  |
| 5   | 50 concurrent sessions streaming | 50/50 complete, 6293 ev/s, lag p99=61ms         | 50/50 complete, 6766 ev/s, sched 2.9%                | Elixir\*\* | **Yes** — scale50 + OOM ramp   |
| 6   | Process spawn/teardown churn     | OS handles it                                   | Port + process links, similar overhead               | Tie        | —                              |
| 7   | Subagent trees (future)          | Manual parent-child tracking, cleanup chains    | DynamicSupervisor, process links, tree stop          | Elixir     | **Yes** — subagent test        |
| 8   | Bridge WebSocket disconnects     | **Does not exist** — events flow directly       | Events lost until reconnection                       | Node       | —                              |
| 9   | Development complexity           | One language, one debugger, one stack trace     | Two languages, two runtimes, cross-runtime debugging | Node       | —                              |
| 10  | Desktop packaging                | Electron bundles Node, zero additional cost     | +50-100MB BEAM runtime, lifecycle management         | Node       | —                              |

\*Scenario 4 revised from "Elixir" to "Tie" after testing: both runtimes isolate child process crashes equally well. Elixir's advantage is automatic DynamicSupervisor cleanup vs manual Map cleanup, not survival.

\*\*Scenario 5 updated: The crossover benchmarks showed both runtimes equivalent up to ~100 sessions. At 200 sessions, Elixir delivers 5.5x better latency and 3.1x better throughput — the shared V8 event loop saturates while BEAM schedulers stay at 0% utilization.

Score: Elixir 2, Node 3, Tie 5. But the scores are not equal in weight.

**Elixir's wins (3, 7) are now quantified.** Memory leak isolation matters after hours of intensive multi-session use — our stress test proved the coupling is real (+145MB shared heap growth, 169ms lag). The crossover benchmarks put a number on the concurrency argument: ~150 sessions is where Node's event loop starts degrading; at 200 it collapses (1.2s lag, throughput drops). Subagent lifecycle integrity was verified up to 90 concurrent subagents.

**Node's wins (8, 9, 10) are present-tense.** The bridge WebSocket is a failure mode that does not exist in the Node-only approach. Two languages mean fewer contributors who can maintain the code. The BEAM runtime must be bundled, installed, and lifecycle-managed on every user's machine.

**The ties are real but have a ceiling.** Crash isolation (scenarios 2, 4) passes identically in both runtimes — we tested with up to 20 simultaneous crashes and all survivors completed in both. But Elixir shows 0.0ms lag spike at every crash intensity, while Node consistently shows 1.4–2.7ms — structural vs behavioral isolation made visible. Scale (scenario 5) is a tie up to ~100 sessions, then Elixir pulls away sharply.

![Honest Scorecard](output/stress-test/charts/scorecard.png)

Where OTP's structural isolation genuinely separates from Node's behavioral isolation:

- **Per-process heaps**: a badly behaved session that accumulates buffers will grow the shared V8 heap, creating memory coupling between all sessions. In our memory leak test, this caused Node's heap to grow to 158MB with 169ms p99 event loop lag — all sessions share this degradation. In BEAM, that session's heap is independent; healthy sessions' memory stayed flat (see [stress test evidence](#appendix-stress-test-evidence)).
- **Unhandled errors**: despite Effect's error channel, a bug in native callback wiring (Node child process events, WebSocket handlers) can escape the Effect boundary and crash the process. In BEAM, a crash is always contained to the process that crashed.
- **Supervision as product**: when subagent trees become real, "start child, monitor child, restart child, stop subtree" map directly to `DynamicSupervisor` operations. In Node, these are application-level abstractions that must be built and maintained.

The honest conclusion from this analysis: **for the current product shape (1-4 sessions, desktop), main's approach is sufficient.** The Elixir argument becomes load-bearing at ~150+ concurrent sessions — a number we can now state with data, not intuition.

## Final Take

If T3Code remained just "a TypeScript app that opens one coding session," I would not push hard for Elixir. The benchmarks confirm this: at 5-50 sessions, both runtimes are functionally identical.

If T3Code becomes "a supervised tree of local agent runtimes and subagents," the argument changes.

That is when Elixir stops being a nice-to-have and starts becoming one of the most natural runtimes for the control plane.

But even then, Node does not go away. It still matters because the product still lives in a JS-shaped world. And the core team's own PR #581 proves that the same architectural patterns — adapters, event projection, session management — work in Node. The patterns are not Elixir-specific. The question is whether their _execution guarantees_ are worth a second runtime.

For some providers, Node is clearly the better home. Julius's Cursor ACP adapter shows what a native integration looks like: structured JSON-RPC with authentication, session persistence, and permission negotiation — things that are harder to bridge across a WebSocket than to call directly.

The position I would actually stand behind:

> Elixir is compelling for the process tree. Node is essential for the intelligence layer. The crossover is not theoretical — it is at ~150 concurrent sessions, with 0.0ms crash lag spikes, constant 268KB per session, and 0% scheduler utilization where Node's event loop is already at 199ms p99 lag.

If T3Code stays at 1-10 sessions, PR #581's approach wins on simplicity alone. If it grows into a supervised forest of concurrent agent runtimes — and the benchmarks show exactly where that forest overwhelms a single event loop — then the OTP argument becomes structural rather than aesthetic.

That is the honest version. Now with numbers.

## Appendix: Stress Test Evidence

After the initial qualitative experiments, we ran a quantitative stress test suite: 8 test types, both runtimes, with mock providers for controlled conditions and real Codex for production-realistic workloads. All test scripts and raw JSON results are in the repository.

### Methodology notes

- **Single-run results.** Each test was run once. Claims are framed as "architectural demonstrations" not "statistically significant differences." No p-values, no confidence intervals — with N=1, those would be meaningless.
- **Mock providers for isolation.** The GC lab, concurrent, scale50, subagent, memory-leak, and exception tests use a configurable mock provider that eliminates API variance. Only the real-workload test uses actual Codex.
- **Different metric scopes.** Node's `heapUsed` measures V8 managed heap only. Elixir's `beamTotalMemory` includes the entire BEAM VM (atom table, code, ETS, all process heaps). We use percentage-of-baseline normalization to make fair comparisons.

### 1. Memory leak isolation (the strongest result)

One leaky session (50KB deltas, never completing) ran alongside 3 healthy sessions for 2 minutes. Both runtimes processed ~113MB of leak payload and completed all 27 healthy turns.

![Memory Leak Divergence](output/stress-test/charts/memory-leak-divergence.png)

**What it shows:** Node's shared V8 heap grew from 100% to 2,800% of baseline because leaked objects are retained in the same heap that all sessions share. Elixir's BEAM total memory stayed at ~102% of baseline — the leaky GenServer's heap oscillated independently (94-352KB) while healthy sessions were completely unaffected.

**CS principle:** Per-process heaps prevent memory coupling between sessions. A leak in one process cannot grow another process's heap.

**Where Node wins:** Both runtimes completed all 27 healthy turns. Node's throughput was not affected — only its memory footprint and event loop lag (p99=169ms) grew. The leak created coupling, not failure.

### 2. Per-session memory attribution (the observability gap)

The GC lab ran two sessions concurrently: Session A received 500 × 500KB deltas (~250MB of data), Session B received 500 × 0.1KB deltas.

![GC Lab Attribution](output/stress-test/charts/gc-lab-attribution.png)

**What it shows:** Elixir can tell you exactly how much memory each session uses: A=13.1MB, B=68KB, with independent GC counts (A: 6, B: 131). Node's response to "how much memory does Session A use?" is the literal string `"not available — shared V8 heap"`.

**CS principle:** This is an architectural impossibility in V8, not a missing feature. The shared heap makes per-session attribution structurally unmeasurable.

### 3. Real workload memory stability

5 Codex sessions simultaneously building different TypeScript apps (todo API, calculator, markdown parser, state machine, event emitter) with full tool access — file creation, editing, command execution, test running. 5 minutes per runtime.

![Real Workload Stability](output/stress-test/charts/real-workload-stability.png)

**What it shows:** Node's `heapUsed` oscillated with a 583 percentage-point range (V8 generational GC sawtooth). Elixir's `beamTotalMemory` stayed within a 6 percentage-point band.

**Where Node wins:** Node processed more events (9,289 vs 5,368), had higher throughput (30 vs 17 events/s), and completed more apps (4/5 vs 2/5). The Elixir harness adds a WebSocket hop that may account for the throughput difference.

**Caveat:** `heapUsed` and `beamTotalMemory` measure different scopes. The percentage-of-baseline view normalizes this, but absolute comparisons between the two metrics should be read with this in mind.

### 4. 50-session scale test

50 concurrent sessions streaming simultaneously (mock provider, 200 × 1KB deltas each).

![Scale50 Distribution](output/stress-test/charts/scale50-distribution.png)

**What it shows:** Both runtimes completed 50/50 sessions with comparable throughput (Node: 6,293 events/s, Elixir: 6,766 events/s). The difference is in what you can _see_: Elixir shows per-session memory for all 50 GenServers (mean=109.7KB, coefficient of variation=1.3%), proving BEAM's reduction-based scheduler allocates resources equally. Node can only report aggregate heap.

**Where Node wins:** Startup time was identical (1.4s both). Node's event loop lag (p99=61ms) is measurable but not catastrophic at this scale.

### 5. Event loop lag under load

Node's event loop lag across different test scenarios.

![Event Loop Lag](output/stress-test/charts/event-loop-lag.png)

**Caveat:** These are different tests with different workloads, session counts, and durations. They show that lag _exists_ under various conditions, not that lag _scales_ with load. Elixir has no equivalent metric because it has no shared event loop — each scheduler handles its own processes independently (avg utilization: 2.9% at 50 sessions).

### 6. Subagent lifecycle integrity

5 concurrent sessions, each spawning 3 subagents via plan mode (mock provider emitting `collab_agent_spawn_begin/end`, `collab_agent_interaction_begin/end` events).

A mock-based integrity test (5 sessions × 3 subagents) confirmed both runtimes handle the lifecycle events correctly.

We then ran a **real subagent test** with Codex gpt-5.4 using `experimentalApi: true` and `collaborationMode: plan`. Two concurrent sessions — building microservices and data pipelines — each triggered 4-6 real subagent spawns:

| Metric             | Node (direct)       | Elixir (harness)     |
| ------------------ | ------------------- | -------------------- |
| Sessions completed | 2/2                 | 2/2                  |
| Subagent spawns    | 9                   | **10**               |
| Total events       | 7,220               | **14,918**           |
| Tool calls         | 321                 | **824**              |
| Duration           | 233s                | 319s                 |
| Memory behavior    | 1.8-51.1MB sawtooth | **51.4→52.7MB flat** |

Elixir processed twice the event volume through the harness while keeping BEAM memory dead flat. The structural argument: each GenServer handles its own subagent events independently, without a central manager having to track `collabReceiverTurns`, rewrite `turnIds`, or suppress duplicate events.

### 7. Claude Code — multi-provider comparison

We ran the same complex-task pattern with Claude Code (claude-sonnet-4-6, 2 sessions building apps with full tool access):

| Metric             | Node (direct) | Elixir (harness)     |
| ------------------ | ------------- | -------------------- |
| Sessions completed | 2/2           | 2/2                  |
| Total events       | 44            | **2,744**            |
| Duration           | 90s           | 90s                  |
| BEAM memory        | N/A           | **51.9→52.5MB flat** |

The event count difference reflects that the Elixir harness captures Claude's granular `stream_event` notifications through its event pipeline, providing richer observability. Both completed in identical wall-clock time.

This confirms the harness handles multiple providers (Codex + Claude) through the same supervision tree with the same memory behavior.

### Reading the evidence

The raw numbers tell a story, but interpreting them requires care. Here is what the real subagent and multi-provider data actually shows — and what it does not.

![Real Subagent Memory](output/stress-test/charts/real-subagent-memory.png)

**Memory during real subagent orchestration.** Ten subagents were spawned across two sessions (dashed red lines mark spawn events). Node's `heapUsed` oscillates violently between 1.8-54MB — peaks every time subagents generate intense tool-use activity, with abrupt drops from V8 generational GC. Elixir's `beamTotalMemory` stays as a stable band between 54-63MB throughout. The pattern is consistent with every other test: V8 has unpredictable spikes, BEAM stays flat.

The cumulative event panel shows Elixir accumulating ~14,900 events vs Node ~7,200. This 2x difference is partly a measurement artifact: Elixir's GenServer captures _all_ events from the Codex port stdout (including internal `codex/event/*` notifications like `token_count`, `mcp_startup_update`), while the Node test script only counted events matching its tracking function. Both runtimes processed the same prompts with the same Codex — Elixir simply _sees_ more events because its pipeline is more granular. The honest claim: Elixir handled a higher event volume with flat memory, but both did the same work. Node finished faster (233s vs 319s).

![Real Subagent Lifecycle](output/stress-test/charts/real-subagent-lifecycle.png)

**Subagent lifecycle patterns are not uniform.** Two real sessions showed distinctly different orchestration patterns:

The microservices session did a "spawn burst" — 4 subagents spawned in quick succession (~40-50s), then long waiting periods as subagents worked in parallel (175 tool calls, 10 turns). The data-pipeline session was more gradual — 6 subagents spawned in two waves, with 649 tool calls distributed across ~280 seconds and sustained `terminal_interaction` events. 649 tool calls in only 3 turns means subagents were doing heavy autonomous work.

This matters because it shows real subagent orchestration is not one pattern — some tasks produce short bursts, others produce sustained parallel workloads. A supervision architecture needs to handle both gracefully.

![Multi-Provider Comparison](output/stress-test/charts/multi-provider-comparison.png)

**The same harness handles both providers with the same memory behavior.** The multi-provider comparison is the chart that ties the argument together:

- **Event throughput:** Codex generates massively more events (subagent spawns, tool calls, delta streams). Claude Code is lighter. The Elixir harness handles both without architectural changes.
- **Wall clock time:** For Codex, Node finishes 63s faster (253s vs 316s) but processes fewer events. For Claude, they are nearly identical (~90s). Node has a throughput advantage in raw completion time.
- **Memory oscillation — the key metric:** Codex on Node oscillates 51.6MB during execution. Codex on Elixir oscillates 8.7MB — 6x less. Claude on Node oscillates 4.5MB. Claude on Elixir oscillates 1.6MB — 3x less. Across both providers, BEAM oscillates 3-6x less than Node. The note at the bottom says it: "BEAM memory stays flat regardless of provider, event volume, or subagent count."

The finding that survives scrutiny: BEAM's memory stability is not a lab phenomenon. It holds with real providers, real subagents, and heterogeneous protocols. Node has competitive (and sometimes superior) throughput, but its memory is unpredictable under multi-agent load. For an application that promises to orchestrate multiple providers simultaneously, memory predictability is the operational advantage that justifies a second runtime.

### What a skeptical reader should challenge

We ran this analysis through a multi-agent adversarial review (4 perspective agents + 1 challenger). The strongest challenges:

1. **"Your hero chart might be a measurement artifact."** `heapUsed` and `beamTotalMemory` measure different scopes. We use percentage-of-baseline normalization to address this, but a fully fair comparison would require comparing Node RSS to BEAM total, or both scoped to session-managed memory only.

2. **"Modern V8 does not stop-the-world."** Correct. Our GC lab detected 0 V8 stop-the-world pauses across all runs. V8's Orinoco concurrent GC handles these data volumes without classic STW pauses. Our claim is about _memory coupling_ (proven: shared heap grows for everyone), not _GC pauses_ (unproven at this scale).

3. **"Why not `worker_threads`?"** Node's `worker_threads` provide per-isolate GC, but each is ~35MB (vs BEAM's 2KB processes), uses cooperative scheduling (no preemption), has no built-in supervision trees, and communicates via structured clone serialization. They are heavyweight V8 isolates, not lightweight processes.

4. **"Node completed 4/5 apps vs Elixir's 2/5 — isn't that a showstopper?"** It's a real gap. The root cause may be harness overhead (WebSocket hop, GenServer message passing) or test timing. We haven't fully investigated. The Elixir argument is about isolation and observability, not throughput.

5. **"All results are single-run."** Yes. We frame claims as architectural demonstrations, not statistically significant differences. The structural properties (per-process heaps, independent GC, supervision cleanup) are architectural guarantees, not statistical observations.
