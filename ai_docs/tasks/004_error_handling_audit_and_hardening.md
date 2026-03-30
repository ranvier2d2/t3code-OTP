# Task: Cross-Stack Error Handling Audit & Hardening

**Goal:** Audit and fix error handling anti-patterns across the Elixir harness and Node/Effect-TS server, applying the "let it crash" vs "defensive at boundaries" framework established this session.

---

## 1. Strategic Analysis

### Framework Established

The error handling framework is documented in `feedback-error-handling.md` (memory). Core principle: **Elixir crashes on preconditions; Node validates at boundaries**. 15 locked decisions now govern error handling patterns.

### Provider Council Audit

Dispatched the same audit prompt to 3 providers (Codex GPT-5.4, Claude Opus 4.6, OpenCode Sonnet 4.6). Synthesis by GPT-5.4 produced a unified recommendation.

---

## 2. Completed Work (PRs merged)

### PR #40 — MCP Event Pipeline + Passive Status Panel

- MCP server startup events wired from all providers through runtime ingestion
- `ThreadMcpStatusPanel` UI showing real-time MCP status per thread
- Claude MCP support: enabled panel, `system/init` extraction, `normalizeMcpState()`
- Codex envelope unwrap (`payload.msg`), status normalization
- Panel UX: loading/empty states, provider-aware button visibility

### PR #41 — Shared OpenCode Runtime Architecture (+ 10 fixes)

- Devin's Sprint 2: per-thread `opencode serve` → shared runtime with ref-counted lifecycle
- **Our 10 fixes** (3 commits pushed to Devin's branch):
  - B1+B3: Atomic `lease_and_subscribe/4`
  - B2: Event filtering catch-all `false`
  - Double-decrement: `release/2` no longer decrements
  - R1: `canonical_term` + `term_to_binary` for config hash
  - R2: SSE exponential backoff (1s→60s, 30 max retries)
  - R3: Registration race retry with structured error tuples
  - Double-subscribe guard (`Map.has_key?` before monitor)
  - `:runtime_sse_degraded` handler
  - `Logger.debug` in event filtering catch-all
- **CodeRabbit review fixes** (1 commit):
  - ETS `:public` → `:protected`
  - Fail active turn on SSE degraded
  - 60s timeout for lease GenServer.call
  - Wrapper PID change on resubscribe (demonitor old, monitor new)
  - Reply to `ready_waiters` on stop paths
  - Remove `data["id"]` from session ID probe

### PR #42 — Cross-Boundary Error Handling (Council unanimous)

- Phoenix channel catch-all `handle_in` returning explicit error
- Guarded `Schema.decodeUnknownSync` in `CodexAdapter.ts`

### PR #43 — Sanitize OpenCode Model Names

- Trim whitespace from model slug/name (fixes `"DeepSeek R1 (Turbo)\t"` SchemaError)
- Dedup by slug at source + cache layer

---

## 3. Success Criteria

- [x] Error handling framework documented in memory (`feedback-error-handling.md`)
- [x] 15 locked decisions covering error handling patterns
- [x] PR #40 merged — MCP panel working for all 4 providers
- [x] PR #41 merged — shared runtime with 10 bug/risk fixes
- [x] PR #42 merged — catch-all handle_in + guarded decode
- [x] PR #43 merged — model name sanitization
- [ ] Finding #4: Fix reply envelope mismatch in `coerceSession`
- [ ] Finding #6: Align timeout budgets (30s Node vs 60s Elixir)
- [ ] Task 003 Layer 2: Granular React Query invalidation for `providersUpdated`
- [ ] Task 003 Layer 3: Virtualize model picker for large model lists

---

## 4. Remaining Findings (from council audit)

### FIX NOW (synthesis recommendation)

| #   | Finding                                                        | File(s)                                                | Status |
| --- | -------------------------------------------------------------- | ------------------------------------------------------ | ------ |
| 4   | Reply envelope mismatch — `coerceSession` reads outer envelope | `HarnessClientAdapter.ts:210`, `harness_channel.ex:23` | TODO   |
| 6   | Blocking 60s `wait_for_ready` vs 30s Node timeout              | `session_manager.ex:64`, `HarnessClientManager.ts:593` | TODO   |

#### Finding #4 Detail

`startSession()` in `HarnessClientAdapter.ts` passes the raw manager reply into `coerceSession()`. Phoenix replies with `%{session: session}` (outer envelope). The manager resolves `payload.response` directly, so `coerceSession` reads the envelope, silently defaulting status to `"connecting"` instead of actual status.

#### Finding #6 Detail

`SessionManager.start_session` blocks Phoenix channel handler for 60s in `wait_for_ready`. Node's request timeout is 30s. Slow providers (OpenCode ~20s) can succeed on Elixir side but timeout on Node side, creating zombie sessions. Immediate fix: align timeouts. Long-term: async session start with `session/ready` event.

### DEFER

| #   | Finding                   | Rationale                                                                  |
| --- | ------------------------- | -------------------------------------------------------------------------- |
| 2   | Reconnect readiness/retry | Reconnect exists; missing is command buffering during transient disconnect |
| 7   | Silent event queue errors | Unbounded queue only fails on shutdown; dropping is correct                |

### CORRECT-AS-IS

| #   | Finding              | Rationale                                                   |
| --- | -------------------- | ----------------------------------------------------------- |
| 5   | Port.close try/catch | OTP terminate cleanup; crashing doesn't improve supervision |

---

## 5. Related Files

### Elixir Harness

- `apps/harness/lib/harness_web/harness_channel.ex` — catch-all handle_in (PR #42)
- `apps/harness/lib/harness/session_manager.ex:64-88` — blocking wait_for_ready (#6)
- `apps/harness/lib/harness/model_discovery.ex` — sanitize_models (PR #43)
- `apps/harness/lib/harness/opencode/runtime_key.ex` — canonical hash (PR #41)
- `apps/harness/lib/harness/opencode/runtime_registry.ex` — ETS :protected (PR #41)
- `apps/harness/lib/harness/providers/opencode_runtime.ex` — shared runtime (PR #41)
- `apps/harness/lib/harness/providers/opencode_session.ex` — Sprint 2 wrapper (PR #41)

### Node Server

- `apps/server/src/provider/Layers/CodexAdapter.ts:634` — guarded decode (PR #42)
- `apps/server/src/provider/Layers/HarnessClientAdapter.ts:210-233` — coerceSession (#4)
- `apps/server/src/provider/Layers/HarnessClientManager.ts:593` — 30s timeout (#6)
- `apps/server/src/wsServer.ts:1054` — ignoreCause on message handler

### Memory & Plans

- `~/.claude/projects/.../memory/feedback-error-handling.md` — error handling framework
- `~/.claude/projects/.../memory/locked-decisions.md` — 15 locked decisions
- `~/.claude/projects/.../memory/project-pr41-runtime-fixes.md` — PR #41 fix summary
- `ai_docs/tasks/003_opencode_model_picker_lag.md` — model picker lag (Layers 2+3)
- `ai_docs/plans/002_pr41_shared_opencode_runtime_fixes.md` — PR #41 fix plan

### Council Results

- Manifest: `/tmp/council-21c7830b.json`
- Results: `/tmp/council-21c7830b.results.json`
- Threads: `council-codex-00b2fe2b`, `council-claudeAgent-00b2fe2b`, `council-opencode-00b2fe2b`, `council-synthesis-00b2fe2b`

---

## 6. Release Note: Cross-Platform Readiness

> Bear in mind for upcoming release cut.

### Current state: macOS-focused, architecturally cross-platform with caveats

**Platform-dependent (needs porting for Windows):**

- **Provider binaries** — harness spawns CLI tools (`codex`, `claude`, `cursor`, `opencode`) via Erlang Ports. Availability varies: `codex`/`claude` are macOS/Linux only, `cursor` is macOS primarily, `opencode` (Go) is likely cross-platform.
- **Process management** — `System.cmd("kill", ...)` for process cleanup is Unix-specific. Windows needs `taskkill`.
- **Dev tooling** — `dev-harness.sh` (bash), port discovery via `lsof`/`kill`, `pixi run dev` — all Unix-oriented.
- **Path handling** — some string interpolation in paths may assume forward slashes.

**Inherently cross-platform (no changes needed):**

- Elixir/OTP (BEAM runs on all three)
- Node/Bun (supports Linux, macOS, Windows)
- React/Vite (platform-agnostic)
- Phoenix channels / WebSocket protocol
- SQLite

**Packaging impact:**

- The harness runs as a dev Mix application (not `mix release`)
- **Linux**: minimal changes (mostly dev scripts)
- **Windows**: real porting effort — process signals, shell scripts → PowerShell, verify provider CLI builds
- **macOS**: current target, works as-is

**Bottom line**: The Elixir/OTP layer is fine on all three platforms. The OS interaction layer (ports, process signals, paths) is macOS/Linux-coupled. Linux support is close; Windows needs deliberate porting.
