# T3Otp-Engine

> **This is an independent, work-in-progress experiment.** It is NOT affiliated with, endorsed by, or approved by the T3Code team or [Ping.gg](https://ping.gg). This repository represents one developer's architectural exploration — nothing more. The T3Code team has their own roadmap and has made no commitments regarding OTP or Elixir.

**An OTP supervision layer for multi-provider AI coding agents.**

T3Otp-Engine is an Elixir/Phoenix harness that manages AI provider processes (Codex, Claude, Cursor, OpenCode) through a single supervised runtime. It connects to a host application via a Phoenix Channel WebSocket — the host owns orchestration, persistence, and UI; the engine owns provider lifecycle, crash isolation, and per-session memory containment.

Built as a fork of [T3Code](https://github.com/pingdotgg/t3code) to explore what happens when you move provider supervision from behavioral discipline to structural guarantees.

> **This is an architectural experiment, not a production release.** Four providers, real responses, real tool execution, real stress tests — but not battle-tested at scale.

---

## Why This Exists

AI coding agents are converging on a common problem: orchestrating multiple provider processes with different protocols, different failure modes, and different lifecycle patterns. Today, each provider needs its own adapter (~3,000 LOC each). T3Otp-Engine collapses that into a single supervision tree where adding a new provider costs ~500-700 LOC.

The deeper argument is that once you manage several concurrent agent sessions — especially with subagents — the job stops looking like "serve some HTTP" and starts looking like "supervise a tree of unstable runtimes." OTP was designed for exactly this class of problem.

For the full architectural case, see the companion blog post: **[Why T3Code Might Want Two Runtimes](docs/elixir-should-not-replace-node.md)**

---

## What It Does

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

**The engine owns:**
- Provider process spawning and supervision (one GenServer per session)
- Crash isolation (one session dies, siblings continue unaffected)
- Per-session memory containment (independent BEAM process heaps)
- Event normalization across 4 heterogeneous protocols
- In-memory snapshot projection with WAL replay
- Dynamic model discovery from provider CLIs

**The host owns:**
- Canonical event mapping to domain types (TypeScript)
- SQLite persistence
- Browser/Electron WebSocket
- Desktop integration
- All existing orchestration logic (Effect-TS)

---

## Quickstart

### Prerequisites

- [Pixi](https://pixi.sh) (manages Erlang toolchain — no global install needed)
- [Elixir](https://elixir-lang.org/install.html) 1.19+ (via `brew install elixir` or `asdf`)
- Node.js 20+ and [bun](https://bun.sh)
- At least one provider CLI installed (`codex`, `claude`, `cursor`, `opencode`)

### Setup

```bash
# Clone
git clone https://github.com/ranvier2d2/t3code.git t3otp-engine
cd t3otp-engine
git checkout worktree-orktree

# Install all dependencies (Node + Hex)
pixi run setup
```

### Run the full stack

```bash
# Starts Elixir harness (port 4321) + Node server (port 3780) + Vite (port 5734)
pixi run dev

# Open browser — switch provider to Cursor or OpenCode, send a prompt
```

### Run individual runtimes

```bash
pixi run harness        # Elixir harness only (port 4321)
pixi run dev-server     # Node server only
pixi run dev-web        # Vite dev server only
```

### Dry-run verification

```bash
# Spawns Elixir harness, connects WebSocket, verifies all channel commands
bun run scripts/harness-dry-run.ts
```

### Run stress tests

```bash
# Mock provider tests (no API keys needed)
bun run scripts/stress-test-runner.ts          # Elixir: scaling + latency
bun run scripts/stress-test-node.ts            # Node: same tests for comparison
bun run scripts/stress-test-memory-leak.ts     # Memory leak isolation
bun run scripts/stress-test-exception.ts       # Crash injection
bun run scripts/stress-test-scale50.ts         # 50-session scale
bun run scripts/stress-test-gc-lab-elixir.ts   # GC cross-contamination lab

# Real provider tests (requires provider API keys)
bun run scripts/stress-test-real-workload.ts --runtime=elixir
bun run scripts/stress-test-real-subagent.ts --runtime=elixir

# Generate charts from results (requires matplotlib, numpy, seaborn)
python3 output/stress-test/viz.py        # Main stress test charts
python3 output/stress-test/viz-real.py   # Real workload charts
```

### Elixir quality checks

```bash
pixi run test-elixir    # ExUnit tests
pixi run credo          # Elixir linter
pixi run format-check   # Formatting check
```

---

## Provider Support

All 4 providers verified end-to-end in browser with real prompts and real tool execution:

| Provider | Transport | Events | Tool Use | Verified |
|----------|-----------|--------|----------|----------|
| Codex | stdio JSON-RPC | 47 events, full turn cycle | `commandExecution` — file created | Y |
| Claude | stdio stream-json | 21 events | file write via `bypassPermissions` | Y |
| Cursor | stdio stream-json | 24 events, thinking + response | file write via `--yolo` | Y |
| OpenCode | HTTP + SSE | 19 events, SSE streaming | `file_change write` via permission reply | Y |

### Feature matrix

| Feature | Codex | Claude | Cursor | OpenCode |
|---------|:-----:|:------:|:------:|:--------:|
| Session lifecycle | Y | Y | Y | Y |
| Send/interrupt turn | Y | Y | Y | Y |
| Approval requests | Y | Y | Y | Y |
| User input questions | Y | Y | -- | Y |
| Thread read/rollback | Y | Y | read only | Y |
| Tool visibility in chat | Y | Y | Y | Y |
| Streaming tool output | Y | Y | --* | --* |
| Dynamic model discovery | -- | -- | Y (80+) | Y (17) |
| Thread persistence | Y | Y | Y | Y |

*Cursor and OpenCode protocols only emit tool start/complete events, no intermediate output. This is an upstream limitation. See [KI-3](output/known-issues.md).*

---

## Stress Test Evidence

8 test types comparing Node/V8 (shared heap) vs Elixir/OTP (per-process heaps) under identical workloads. Single-run results framed as architectural demonstrations, not statistical claims.

### Memory leak isolation — the headline result

One leaky session (50KB deltas, never completing) alongside 3 healthy sessions for 2 minutes:

![Memory Leak Isolation](output/stress-test/charts/memory-leak-divergence.png)

- **Node:** shared V8 heap grew to 2,800% of baseline (5MB to 158MB), p99 event loop lag 169ms
- **Elixir:** BEAM total memory stayed at 102% of baseline, leaky process isolated at 94-352KB
- **Both:** completed all 27 healthy turns

### Per-session observability — the architectural impossibility

![GC Lab Attribution](output/stress-test/charts/gc-lab-attribution.png)

Elixir reports per-session memory (A=13.1MB, B=68KB) with independent GC counts. Node cannot — the shared V8 heap makes per-session attribution structurally unmeasurable.

### Real subagent orchestration — Codex gpt-5.4 plan mode

![Real Subagent Memory](output/stress-test/charts/real-subagent-memory.png)

10 real subagents across 2 sessions. Node oscillates 1.8-54MB. Elixir holds 54-63MB flat while processing 14,918 events and 824 tool calls.

### Honest scorecard

![Scorecard](output/stress-test/charts/scorecard.png)

Elixir wins on isolation and observability. Node wins on throughput and SDK ecosystem. Hence: two runtimes, each handling what it does best.

Full analysis with methodology notes, caveats, and adversarial review: [`output/stress-test/analysis.md`](output/stress-test/analysis.md)

---

## Architecture

### Elixir harness (`apps/harness/`)

| Module | LOC | Purpose |
|--------|-----|---------|
| `SessionManager` | 224 | DynamicSupervisor routing, session lifecycle |
| `CodexSession` | 380 | Codex JSON-RPC GenServer |
| `ClaudeSession` | 530 | Claude CLI stream-json GenServer |
| `CursorSession` | 712 | Cursor stream-json GenServer + tool mapping |
| `OpenCodeSession` | 1,050 | OpenCode HTTP+SSE GenServer + tool mapping |
| `MockSession` | 220 | Configurable mock for stress testing |
| `SnapshotServer` | 380 | In-memory event store + WAL replay |
| `ModelDiscovery` | 149 | CLI-based model listing with ETS cache |
| `HarnessChannel` | 246 | Phoenix Channel — single WebSocket entry point |

### Node integration

| File | LOC | Purpose |
|------|-----|---------|
| `HarnessClientAdapter.ts` | 1,083 | Single adapter implementing all 13 `ProviderAdapterShape` methods |
| `HarnessClientManager.ts` | 586 | Phoenix Channel WebSocket client with reconnection |
| `codexEventMapping.ts` | 1,244 | Extracted event mapping (shared with existing CodexAdapter) |

### The boundary

| Concern | Owner |
|---------|-------|
| Provider process lifecycle | Elixir |
| Crash isolation + supervision | Elixir |
| Per-session memory containment | Elixir |
| Event normalization | Elixir |
| Canonical event mapping (TS types) | Node |
| SQLite persistence | Node |
| Browser/Electron WebSocket | Node |
| Desktop + product integration | Node |

---

## Adding a New Provider

1. Create `apps/harness/lib/harness/providers/new_session.ex` (~500-700 LOC)
2. Add clause to `SessionManager.provider_module/1`
3. Add provider kind to `packages/contracts/src/orchestration.ts`
4. Done. No new TypeScript adapter.

For comparison, the current per-adapter pattern requires ~3,000 LOC of new TypeScript per provider.

---

## Known Limitations

- **Sidebar stale state (KI-1):** `ProviderRuntimeIngestion.ts` requires a thread to exist before processing events. Fix identified, not yet shipped. See [known-issues.md](output/known-issues.md).
- **No streaming tool output for Cursor/OpenCode (KI-3):** upstream protocol limitation — both protocols only emit tool start/complete events.
- **Cursor:** no rollback API, no user-input question events (protocol limitations).
- **Desktop packaging:** BEAM runtime adds ~60-80MB to Electron bundle.
- **Single-run stress tests:** results are architectural demonstrations, not statistically significant. Structural properties (per-process heaps, supervision cleanup) are guarantees, not observations.

---

## Relationship to T3Code

T3Otp-Engine is a fork of [T3Code](https://github.com/pingdotgg/t3code) by [Ping.gg](https://ping.gg). The Elixir harness is entirely additive — it does not modify or replace existing Node adapters. The existing `CodexAdapter` and `ClaudeAdapter` continue to work unchanged.

The T3Code core team has an open PR exploring the same space: [**#581: Centralize all harnesses with single websocket server**](https://github.com/pingdotgg/t3code/pull/581). Both approaches work. The difference is in execution guarantees: behavioral isolation (Node) vs structural isolation (OTP). See the [blog post](docs/elixir-should-not-replace-node.md) for a detailed comparison.

This fork is offered as an architectural exploration, not a merge request. If the patterns prove useful, they can inform T3Code's own multi-provider architecture regardless of runtime choice.

---

## License

Same as upstream T3Code. See [LICENSE](LICENSE).

---

## Author

**Bastian Venegas Arevalo** ([@ranvier2d2](https://github.com/ranvier2d2))
CTO, [Ranvier Technologies](https://ranvier-technologies.com)


