# T3Otp-Engine

> **Independent experiment.** Not affiliated with, endorsed by, or approved by the T3Code team or [Ping.gg](https://ping.gg). One developer's architectural exploration — nothing more.

An OTP supervision layer for multi-provider AI coding agents. Four providers, real responses, real tool execution — managed through a single supervised runtime instead of per-provider adapter discipline.

Built as a fork of [T3Code](https://github.com/pingdotgg/t3code). For the full architectural case: **[Why T3Code Might Want Two Runtimes](https://ranvier-technologies.github.io/t3code-OTP/)**.

```
Browser ──── Node Server ──────────── T3Otp-Engine (Elixir)
               │                           │
               │◄── Phoenix Channel WS ──►│
               │    (single connection)    │
               │                           ├── CodexSession    (stdio JSON-RPC)
               │                           ├── ClaudeSession   (stdio stream-json)
               │                           ├── CursorSession   (stdio stream-json)
               │                           └── OpenCodeSession (HTTP + SSE)
               │                           │
               │    normalized events      │
               │◄──────────────────────────│
```

---

## The idea

Once you manage several concurrent agent sessions — each with its own protocol, failure modes, and lifecycle — the job stops looking like "serve some HTTP" and starts looking like "supervise a tree of unstable runtimes." OTP was designed for exactly this class of problem.

The engine owns supervision, crash isolation, and per-session memory containment. Node keeps everything else: Agent SDK access, TypeScript contracts, SQLite persistence, desktop integration, and the entire existing orchestration layer.

| Concern                            | Owner  |
| ---------------------------------- | ------ |
| Provider process lifecycle         | Elixir |
| Crash isolation + supervision      | Elixir |
| Per-session memory containment     | Elixir |
| Event normalization                | Elixir |
| Canonical event mapping (TS types) | Node   |
| SQLite persistence                 | Node   |
| Browser/Electron WebSocket         | Node   |
| Desktop + product integration      | Node   |

---

## Quickstart

**Prerequisites:** [Pixi](https://pixi.sh) (manages Erlang toolchain), Elixir 1.19+, Node.js 20+, [bun](https://bun.sh), and at least one provider CLI (`codex`, `claude`, `cursor`, `opencode`).

```bash
git clone https://github.com/Ranvier-Technologies/t3code-OTP.git t3otp-engine
cd t3otp-engine
git checkout worktree-orktree

pixi run setup    # Install all dependencies (Node + Hex)
pixi run dev      # Starts Elixir harness + Node server + Vite
```

Open browser, switch provider, send a prompt.

### Individual runtimes

```bash
pixi run harness      # Elixir harness only (port 4321)
pixi run dev-server   # Node server only
pixi run dev-web      # Vite dev server only
```

### Verification

```bash
bun run scripts/harness-dry-run.ts   # Connects WS, verifies all channel commands
pixi run test-elixir                 # ExUnit tests
pixi run credo                       # Elixir linter
```

---

## Provider support

All 4 providers verified E2E in browser with real prompts and real tool execution:

| Provider | Transport                         | Tool Use                                 | Models         |
| -------- | --------------------------------- | ---------------------------------------- | -------------- |
| Codex    | stdio JSON-RPC via Erlang Port    | `commandExecution` — file created        | —              |
| Claude   | stdio stream-json via `/bin/sh`   | file write via `bypassPermissions`       | —              |
| Cursor   | stdio stream-json via Erlang Port | file write via `--yolo`                  | 80+ discovered |
| OpenCode | HTTP + SSE via raw TCP + Req      | `file_change write` via permission reply | 18 discovered  |

Full feature matrix including session lifecycle, approval requests, streaming tool output, and thread persistence: see the [companion writeup](https://ranvier-technologies.github.io/t3code-OTP/).

---

## Stress tests

8 test types comparing Node/V8 (shared heap) vs Elixir/OTP (per-process heaps). Single-run results framed as architectural demonstrations, not statistical claims. Structural properties (per-process heaps, supervision cleanup) are BEAM guarantees, not observations.

### The headline numbers

| Metric                                  | Node                                      | Elixir                        |
| --------------------------------------- | ----------------------------------------- | ----------------------------- |
| Memory with 1 leaky session             | Shared heap → 2,800% of baseline (158 MB) | BEAM total → 102% of baseline |
| Event loop lag during leak              | p99 = 169ms                               | N/A (no shared event loop)    |
| Sibling sessions affected               | All degraded                              | Zero                          |
| Latency at 200 concurrent sessions      | 3,314ms p99                               | 607ms p99                     |
| Throughput at 200 sessions              | 5,779 ev/s (event loop saturated)         | 18,000 ev/s                   |
| Per-session memory (5→200 sessions)     | Unmeasurable (shared heap)                | Constant ~268KB               |
| Crash lag spike (up to 20 simultaneous) | 1.4–2.7ms                                 | 0.0ms at every count          |

### Real workload

Codex gpt-5.4 in plan mode, 10 subagents across 2 sessions: Node oscillated 1.8–54 MB. Elixir held 54–63 MB flat while processing 14,918 events and 824 tool calls.

**Honest scorecard:** Elixir wins on isolation, observability, and per-session memory attribution. Node wins on raw throughput and SDK ecosystem access. Hence: two runtimes.

Full analysis with methodology, caveats, and adversarial review: [`output/stress-test/analysis.md`](output/stress-test/analysis.md).

### Running the tests

```bash
# Mock provider tests (no API keys needed)
bun run scripts/stress-test-runner.ts          # Scaling + latency
bun run scripts/stress-test-node.ts            # Same tests, Node baseline
bun run scripts/stress-test-memory-leak.ts     # Memory leak isolation
bun run scripts/stress-test-exception.ts       # Crash injection
bun run scripts/stress-test-scale50.ts         # 50-session scale
bun run scripts/stress-test-gc-lab-elixir.ts   # GC cross-contamination

# Real provider tests (requires API keys)
bun run scripts/stress-test-real-workload.ts --runtime=elixir
bun run scripts/stress-test-real-subagent.ts --runtime=elixir

# Generate charts
python3 output/stress-test/viz.py
python3 output/stress-test/viz-real.py
```

---

## Architecture

### Elixir harness (`apps/harness/`)

| Module            | LOC   | Role                                         |
| ----------------- | ----- | -------------------------------------------- |
| `SessionManager`  | 224   | DynamicSupervisor routing, session lifecycle |
| `CodexSession`    | 380   | Codex JSON-RPC GenServer                     |
| `ClaudeSession`   | 530   | Claude CLI stream-json GenServer             |
| `CursorSession`   | 712   | Cursor stream-json + tool mapping            |
| `OpenCodeSession` | 1,050 | OpenCode HTTP+SSE + tool mapping             |
| `MockSession`     | 220   | Configurable mock for stress testing         |
| `SnapshotServer`  | 380   | In-memory event store + WAL replay           |
| `ModelDiscovery`  | 149   | CLI-based model listing with ETS cache       |
| `HarnessChannel`  | 246   | Phoenix Channel — single WS entry point      |

### Node integration

| File                      | LOC   | Role                                                        |
| ------------------------- | ----- | ----------------------------------------------------------- |
| `HarnessClientAdapter.ts` | 1,083 | Single adapter: all 13 `ProviderAdapterShape` methods       |
| `HarnessClientManager.ts` | 586   | Phoenix Channel WS client with reconnection                 |
| `codexEventMapping.ts`    | 1,244 | Extracted event mapping (shared with existing CodexAdapter) |

---

## Adding a new provider

1. Create `apps/harness/lib/harness/providers/new_session.ex` (~500–700 LOC)
2. Add clause to `SessionManager.provider_module/1`
3. Add provider kind to `packages/contracts/src/orchestration.ts`

No new TypeScript adapter. For comparison, the current per-adapter pattern requires ~3,000 LOC of new TypeScript per provider.

---

## Known limitations

- **Sidebar stale state (KI-1):** `ProviderRuntimeIngestion.ts` requires a thread to exist before processing events. Fix identified, not shipped. See [known-issues.md](output/known-issues.md).
- **No streaming tool output for Cursor/OpenCode (KI-3):** upstream protocol limitation — only tool start/complete events emitted.
- **Cursor:** no rollback API, no user-input question events (protocol limitations).
- **Desktop packaging:** BEAM runtime adds ~60–80 MB to Electron bundle.
- **Single-run stress tests:** architectural demonstrations, not statistically significant.

---

## Relationship to T3Code

This is a fork of [T3Code](https://github.com/pingdotgg/t3code) by [Ping.gg](https://ping.gg). The Elixir harness is entirely additive — existing Node adapters (`CodexAdapter`, `ClaudeAdapter`) continue to work unchanged.

The T3Code core team has an open PR exploring the same space: [**#581: Centralize all harnesses with single websocket server**](https://github.com/pingdotgg/t3code/pull/581). Both approaches work. The difference is in execution guarantees: behavioral isolation (Node) vs structural isolation (OTP).

This fork is offered as an architectural exploration, not a merge request.

---

## Related reading

- [Why T3Code Might Want Two Runtimes](https://ranvier-technologies.github.io/t3code-OTP/) — the companion writeup with interactive diagrams
- [George Guimarães: "Your Agent Framework Is Just a Bad Clone of Elixir"](https://www.yourstack.com/george-guimaraes/your-agent-framework-is-just-a-bad-clone-of-elixir) — industry context on the BEAM/agent convergence
- [codingsh: "Why Elixir is Perfect for AI Agents"](https://dev.to/codingsh/why-elixir-is-perfect-for-ai-agents-5ce0) — practical BEAM patterns for long-running agent nodes
- [Full stress test analysis](output/stress-test/analysis.md) — methodology, caveats, adversarial review

---

## License

Same as upstream T3Code. See [LICENSE](LICENSE).

## Author

**Bastian Venegas Arevalo** ([@ranvier2d2](https://github.com/ranvier2d2)) · CTO, [Ranvier Technologies](https://ranvier-technologies.com)
