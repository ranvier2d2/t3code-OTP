# 005: Pitch T3Code-OTP to Upstream PR #581

**Status:** DRAFTING — upstream PR details verified, draft refinements identified

## Goal

Craft a compelling, honest PR comment on t3dotgg/t3code#581 that positions the OTP fork as a complementary architectural exploration — not a competing rewrite. The comment should resonate with Theo (product vision, shipping pragmatism), Julius (deep codebase contributor, 832 commits), and Maria (team context).

## Context

### What PR #581 Is (VERIFIED)

Theo opened a draft PR 3 weeks ago titled "Centralize all harnesses with single websocket server." Self-described as "3 prompts in" and "trying to make a standard." It introduces:

- **Package:** `packages/harness-ws-server/`
- `src/server.ts` — `HarnessService` — session lifecycle + event publishing + snapshot projection
- `src/adapters.ts` — `HarnessAdapter` interface — `createSession`/`sendTurn`/`cancelTurn`/`resolvePermission`/`resolveElicitation`/`streamEvents`/`shutdownSession`
- `src/storage.ts` — `HarnessMemoryStore` (194 LOC) — in-memory event storage + snapshot persistence
- `src/projector.ts` — `projectHarnessEvent()` — immutable snapshot from events
- `src/claude.ts` (144 LOC), `src/codex.ts` (434 LOC), `src/opencode.ts` (441 LOC) — adapters
- Contract schemas: `packages/contracts/src/harness.ts`, `harnessEvents.ts`, `harnessWs.ts`
- +3,140 / -6 lines, 24 files, all TypeScript
- **Macroscope found 9 real bugs** (2 HIGH: streaming never starts, sequence regression; 3 MEDIUM: shutdown race, connector data loss, hardcoded key)

### Julius's Reaction to PR #581

> **"Wha tis different here than the current Provider\* lol?"**

This is the only human review on the PR. Julius is questioning why a new `HarnessService` abstraction is needed when the existing `ProviderAdapter` + `ProviderService` pattern already handles session lifecycle. This is the most important signal for tone calibration — our comment should address this question indirectly by showing what the abstraction _enables_ at scale.

### Upstream Team Activity (VERIFIED)

- **~1,000 PRs in 3 weeks** (PR #581 → PR #1560+). Shipping velocity is extreme.
- **Julius's Cursor ACP: PR #1355** (not #178). 10K+ lines. Full ACP protocol with JSON-RPC framing, session persistence, mode mapping. New `packages/effect-acp/` package.
- **Julius's subagent work: PR #1199** — "Add subagent work units across providers" — labeled "EARLY VIBED DO NOT USE". Generic turn-scoped work-unit model, `WorkUnitId` entity, provider-agnostic execution tree. They're already thinking about this.
- **Julius's perf refactor: PR #1560** — Incremental events over snapshot polling (UI perf regression fix).
- **Effect-TS is the server-side standard.** Julius wraps everything in `Effect.fn` with layers. Contracts use `@effect/schema`.
- **No comments from Maria on PR #581.**

### What We Built (T3Code-OTP Fork)

Same architecture, different runtime underneath. The fork is at [Ranvier-Technologies/t3code-OTP](https://github.com/Ranvier-Technologies/t3code-OTP).

**Scale of work:**

- 201 fork-specific commits (118 Bastian + 24 Devin AI + 14 Cursor Agent + others)
- 10,681 LOC Elixir harness (`apps/harness/lib/`) + 2,606 LOC tests
- 69,551 LOC Node server (unchanged, shared with upstream)
- 43 merged PRs
- Full writeup: `docs/post.md` ("Why T3Code Might Want Two Runtimes")
- 5-benchmark stress test suite with charts

**What works E2E in browser:**

- All 4 providers (Codex, Claude, Cursor, OpenCode) with real prompts, real tool execution, real streaming
- Text streaming, reasoning, tool lifecycle, approval flow, model discovery, session persistence, multi-turn
- MCP status panel for all providers
- Shared OpenCode runtime with ref-counted lifecycle

### The 1:1 Architecture Mapping

| PR #581 (Node)                | T3Code-OTP (Elixir)                | Notes                          |
| ----------------------------- | ---------------------------------- | ------------------------------ |
| `HarnessService`              | `SessionManager`                   | Session lifecycle, routing     |
| `HarnessAdapter` interface    | `ProviderBehaviour`                | 6-method contract              |
| `HarnessMemoryStore`          | `SnapshotServer` (GenServer)       | In-memory + WAL ring buffer    |
| `HarnessSnapshot` + projector | `Snapshot` + `Projector.project/2` | Pure function                  |
| codex adapter                 | `CodexSession` (597 LOC)           | stdio JSON-RPC via Erlang Port |
| claude adapter                | `ClaudeAdapter.ts` (stays in Node) | Agent SDK is Node-only         |
| opencode adapter              | `OpenCodeSession` (1,092 LOC)      | HTTP + SSE via raw TCP + Req   |
| WS server                     | Phoenix Channel                    | Single topic, typed contract   |

### Benchmark Data (Crossover Suite)

**Session Count Ramp (5 → 200 concurrent):**

| Sessions | Node P99    | Elixir P99 | Node ev/s | Elixir ev/s | Node Loop Lag |
| -------- | ----------- | ---------- | --------- | ----------- | ------------- |
| 5        | 1,123ms     | 1,124ms    | 445       | 445         | —             |
| 50       | 1,170ms     | 1,100ms    | 4,244     | 4,529       | 5.6ms         |
| 100      | 1,206ms     | 1,120ms    | 7,949     | 8,621       | 27.3ms        |
| 150      | 1,605ms     | 1,486ms    | 8,782     | 9,053       | **199ms**     |
| **200**  | **3,314ms** | **607ms**  | **5,779** | **18,000**  | **1,209ms**   |

**Crossover: ~150 sessions.** Below 100, both runtimes are functionally identical. At 200, Node's event loop saturates.

**Failure Storm (30 sessions, K crashes):**

- Elixir: 0.0ms lag spike at every crash count (0-20 simultaneous)
- Node: 1.4-2.7ms lag spike (crash cleanup on event loop)
- Both: 100% survivor correctness, zero errors

**Memory Leak Isolation:**

- Node shared heap: 2,800% baseline growth, 169ms p99 lag
- Elixir: 102% baseline, healthy sessions completely unaffected

### What We're NOT Saying

- This is not a merge request
- Elixir does not replace Node (event mapping, Claude SDK, Electron, SQLite, desktop all stay in Node)
- BEAM adds ~60-80MB to Electron bundle (real shipping friction)
- Two runtimes = two debuggers, two log systems (real dev friction)
- For 1-10 sessions today, PR #581's Node approach wins on simplicity

### The Honest Framing

> Elixir owns the process tree. Node owns the intelligence layer.

The crossover number (~150 sessions) gives a concrete decision point. Below that, Node-first with confidence. Subagent trees change the math — parent-child cancellation, partial failure, concurrent approvals across siblings map natively to OTP supervision.

## Deliverables

### 1. PR Comment (Primary)

A comment on t3dotgg/t3code#581 that:

- Opens with the 1:1 mapping (shows this is the same idea, not a different one)
- Presents benchmark crossover data with the specific number (~150)
- Acknowledges what Node does better (shipping, ecosystem, single debugger)
- Names the subagent argument explicitly
- Links the fork and writeup
- Tone: practical, factual, no Elixir evangelism. Let the data argue.

### 2. Writeup Link

The full writeup lives at `docs/post.md` and is published at `https://ranvier-technologies.github.io/t3code-OTP/`. Reference but don't duplicate — the PR comment should stand alone.

### 3. Tone Calibration

**For Theo:** Product vision + pragmatic shipping tradeoffs. He'll immediately think about packaging cost, contributor friction, and whether this means rewriting. Preempt those.

**For Julius:** Technical depth + respect for existing codebase. He has 832 commits. Acknowledge his Cursor ACP work (PR #1355) as the right integration path for Cursor. Reference his subagent work (PR #1199) to show you've read the code. Address his "what's different than Provider*?" question by showing *when\* the new abstraction earns its keep (scale + subagents).

**For the community:** The "what I'm NOT saying" section matters. GitHub comments get screenshot'd and quote-tweeted. Control the narrative.

## Key Files

- `docs/post.md` — full writeup (the source of truth)
- `docs/elixir-should-not-replace-node.md` — alternate version with stronger caveats
- `scripts/benchmark-*.ts` — 5 benchmark scripts
- `apps/harness/lib/` — 10,681 LOC Elixir harness
- `apps/server/src/provider/Layers/HarnessClient*.ts` — Node bridge

## Anti-Goals

- Do NOT position this as "you should use Elixir"
- Do NOT minimize Node's advantages
- Do NOT oversell benchmark results beyond what they prove
- Do NOT make this about language preference
- Do NOT ignore the real costs (bundle size, contributor pool, debugging)

## Success Criteria

- [ ] PR comment posted on t3dotgg/t3code#581
- [ ] Comment includes 1:1 architecture mapping table
- [ ] Comment includes crossover number with data
- [ ] Comment includes "what I'm NOT saying" section
- [ ] Comment links fork + writeup
- [ ] Tone checked: no evangelism, no underselling, factual
- [ ] Acknowledged Julius's Cursor ACP work
- [ ] Named concrete decision point (session count threshold)

## REFINED DRAFT COMMENT (v2)

```markdown
Hey — this PR is building the same architecture I've been exploring in a fork, different runtime underneath. Figured it's worth sharing since you're 3 prompts in and I'm ~200 commits deep on the same problem.

**Fork:** [Ranvier-Technologies/t3code-OTP](https://github.com/Ranvier-Technologies/t3code-OTP)
**Writeup:** [Why T3Code Might Want Two Runtimes](https://ranvier-technologies.github.io/t3code-OTP/)

### The 1:1 mapping

An Elixir/OTP supervision layer that sits behind the same single-WebSocket, unified-adapter architecture:

| PR #581 (Node)             | T3Code-OTP (Elixir)                     | Notes                                                                      |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `HarnessService`           | `SessionManager`                        | Session lifecycle, command routing                                         |
| `HarnessAdapter` interface | `ProviderBehaviour`                     | `createSession`/`sendTurn`/`cancelTurn`/`resolvePermission`/`streamEvents` |
| `HarnessMemoryStore`       | `SnapshotServer` (GenServer)            | In-memory state with WAL ring buffer                                       |
| `projectHarnessEvent`      | `Projector.project/2`                   | Pure function: `project(snapshot, event) → snapshot`                       |
| codex adapter (434 LOC)    | `CodexSession` (597 LOC GenServer)      | stdio JSON-RPC via Erlang Port                                             |
| claude adapter (144 LOC)   | `ClaudeAdapter.ts` (stays in Node)      | Agent SDK is Node-only — no bridge needed                                  |
| opencode adapter (441 LOC) | `OpenCodeSession` (1,092 LOC GenServer) | HTTP + SSE via raw TCP                                                     |
| WS server                  | Phoenix Channel                         | Single topic, typed contract                                               |

Same patterns. Same adapter model. All 4 providers running E2E in the browser — real prompts, real tool execution, real streaming. Claude stays in Node (Agent SDK). The other three go through Elixir GenServers. Node keeps all the TypeScript contracts, Effect schemas, event mapping, SQLite, Electron.

### Where the runtimes diverge

For 1-10 sessions, the Node approach in this PR wins outright — simpler, no second runtime, no bridge. We benchmarked the crossover:

| Sessions | Node p99    | Elixir p99 | Node throughput | Elixir throughput |
| -------- | ----------- | ---------- | --------------- | ----------------- |
| 50       | 1,170ms     | 1,100ms    | 4,244 ev/s      | 4,529 ev/s        |
| 100      | 1,206ms     | 1,120ms    | 7,949 ev/s      | 8,621 ev/s        |
| **200**  | **3,314ms** | **607ms**  | **5,779 ev/s**  | **18,000 ev/s**   |

**Below ~100 sessions, both runtimes are functionally identical.** At 200, Node's event loop saturates — latency jumps 5.5x, throughput actually _drops_. Elixir doesn't notice (0% scheduler utilization, constant ~268KB per session).

Crash isolation: with 20 simultaneous session crashes in a 30-session pool, Elixir shows 0.0ms lag spike on survivors. Node shows 1.4–2.7ms (cleanup on the event loop). Both achieve 100% survivor correctness.

### Where it gets interesting: subagents

I know you're already exploring this space. When a parent session spawns child agents across providers, OTP answers "what happens if one crashes / the parent cancels / one leaks memory" structurally — each subagent is a GenServer under a DynamicSupervisor, parent crash cascades via process links, one child's memory leak is contained to its own heap.

We tested with real Codex gpt-5.4 in plan mode (10 subagents across 2 sessions). Node oscillated 1.8–54MB. Elixir held 54–63MB flat while processing 14,918 events and 824 tool calls.

### What I'm NOT saying

- This is not a merge request — it's an architectural exploration
- Elixir does not replace Node. Node still owns event mapping, TypeScript contracts, Effect layers, Claude SDK, Electron, SQLite, desktop
- The BEAM adds ~60-80MB to the Electron bundle. That's real shipping friction
- Two runtimes = two debuggers, two log systems, cross-runtime stack traces. That's real dev friction
- Julius's Cursor ACP adapter (PR #1355) is a better integration than spawning the CLI — some providers genuinely belong in Node

### The honest framing

> Elixir owns the process tree. Node owns the intelligence layer.

If T3Code stays at 1-10 sessions, this PR's approach wins on simplicity alone. If it grows into concurrent subagent trees across providers — and the benchmarks show exactly where the event loop ceiling is — the OTP argument becomes structural rather than aesthetic.

The fork has the full writeup, all 5 stress test scripts, raw data, and an adversarial multi-perspective review. Happy to answer questions or walk through any of it.
```

---

## Draft Comment Refinements (VERIFIED)

Based on upstream agent findings, the original draft needs these corrections:

1. **PR #581 file names** — CONFIRMED. `HarnessService` in `server.ts`, `HarnessAdapter` in `adapters.ts`, `HarnessMemoryStore` in `storage.ts`, `projectHarnessEvent` in `projector.ts`. Draft mapping table is accurate.
2. **Commit count** — Draft says "94 commits in." Actual fork-specific count: **201 commits**. Update.
3. **Julius's Cursor ACP PR** — Draft says #178. Actual: **#1355**. 10K+ lines with `packages/effect-acp/`. Update.
4. **Julius's subagent work** — Not in draft. PR #1199 exists ("EARLY VIBED DO NOT USE"). This strengthens the subagent argument — they're already exploring it. Add a nod.
5. **Julius's skepticism** — Not in draft. His "Wha tis different here than the current Provider\*?" is THE question. Our comment should answer it without quoting him directly. The answer: "at 1-10 sessions, nothing. At 150+, supervision guarantees."
6. **Chart links** — Charts are in `output/stress-test/charts/` but are local PNGs. For the PR comment, either:
   - Upload as image attachments (paste into GitHub comment editor)
   - Link to the published writeup which has them embedded
   - Or just present the numbers in tables (simpler, scannable)
7. **Shipping velocity context** — ~1,000 PRs in 3 weeks. This team ships FAST. The comment should be concise and dense — they won't read a novel. Trim to essentials.
8. **Effect-TS awareness** — The draft doesn't mention Effect. Julius uses it everywhere. Acknowledging that the contracts/server use Effect-TS schemas shows technical respect.
9. **PR #581 is rough** — Macroscope found 9 bugs (2 HIGH). Don't mention this — it would be rude. But it confirms Theo's "3 prompts in" framing, which means the architecture is still malleable.
10. **Subagent data** — Draft mentions "Codex gpt-5.4 in plan mode (10 subagents across 2 sessions), Node oscillated 1.8–54MB, Elixir held 54–63MB flat, 14,918 events, 824 tool calls." This is from the real workload stress test. Keep it.

## Strategic Recommendations

### Format: PR Comment vs GitHub Discussion

**Recommendation: PR comment.** Reasons:

- It's where the conversation is happening
- Theo explicitly said "trying to make a standard" — this is an invitation for input
- A Discussion would be easy to miss given their velocity
- PR comments are threaded and discoverable

### Length Calibration

The current draft is ~800 words. Given the team's velocity (~1,000 PRs / 3 weeks), they scan fast. Recommendations:

- **Lead with the 1:1 table** — instant credibility, shows you understand their architecture
- **Benchmark summary in one table** — not the full 7-row breakdown, just the headline: "identical at 50, diverges at 150, collapses at 200"
- **Subagent argument in 3 sentences** — they already have PR #1199, so this resonates
- **"What I'm NOT saying" as a bulleted list** — fast to scan, controls narrative
- **Total target: ~500-600 words** — dense, no padding

### Tone Adjustments

1. **Remove "I'm 94 commits in"** — sounds competitive. Replace with linking the fork and letting the work speak.
2. **Don't say "same architecture"** — Julius already questions why the new abstraction exists. Say "same patterns" or "same adapter model."
3. **Acknowledge the existing ProviderService** — this validates Julius's instinct that the patterns already exist.
4. **Name the crossover number early** — "Below 100 sessions, both approaches are identical. Here's what changes above that."

## Open Questions

- Should benchmark charts be uploaded as images in the PR comment? (GitHub supports drag-and-drop image paste)
- Should the writeup be linked as the published site or the raw markdown in the repo?
- Is a PR comment the right venue, or would a GitHub Discussion be less intrusive?
- Should the comment explicitly reference Julius's PR #1199 subagent work, or just allude to "subagent orchestration"?
