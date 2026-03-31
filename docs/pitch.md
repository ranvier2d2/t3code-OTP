# Why T3Code might want two runtimes

OTP supervision for multi-provider AI agents — an additive architectural exploration

[Bastian Venegas Arevalo](https://github.com/ranvier2d2) · Ranvier Technologies · Relates to [PR #581](https://github.com/pingdotgg/t3code/pull/581)

T3Code's [PR #581](https://github.com/pingdotgg/t3code/pull/581) centralizes harness adapters behind a single `HarnessService` WebSocket server with event projection via `projector.ts`. This is the right direction — a unified contract across providers is exactly what multi-agent orchestration needs.

This page explores what happens when you take that same contract and add an OTP supervision layer underneath it. Not replacing the Node server — extending it with structural guarantees for the part that's hardest to get right: managing concurrent, crash-prone agent sessions.

This is an independent experiment. Not affiliated with or endorsed by the T3Code team. The T3Code team has their own roadmap — this is one developer's architectural exploration.

**A note on scope.** The `HarnessService` abstraction in PR #581 is itself still under discussion — Theo's own review comment asks what differentiates it from the existing `ProviderService` / `ProviderServiceLive` layer. This exploration treats the harness boundary as a useful architectural surface regardless of where it ultimately lives in T3Code's stack. If the team consolidates `HarnessService` back into `ProviderService`, the OTP mapping still applies — it's the supervision boundary that matters, not the class name.

## The constraint that shapes everything

Anthropic only lets you access Claude Code through a Claude Max subscription (instead of per-usage API billing) if you use their **Agent SDK**. The Agent SDK is implemented in Node. There is no Elixir version. So Claude and Codex _must_ stay Node — that's non-negotiable.

This means any OTP layer has to be additive. It sits underneath the existing Node server, connected by a single WebSocket, handling supervision and lifecycle while Node retains SDK access, persistence, and TypeScript contracts.

## The convergence everyone's noticing

This isn't a novel observation. George Guimarães [documented the same convergence](https://www.yourstack.com/george-guimaraes/your-agent-framework-is-just-a-bad-clone-of-elixir) across LangGraph, AutoGen, CrewAI, and Langroid — every major agent framework is independently reinventing the actor model. Isolated state, message passing, supervision hierarchies, fault recovery: all solved problems on the BEAM since 1986.

T3Code's `HarnessService` centralization follows the same pattern. The question isn't whether you need these primitives — you clearly do, that's what PR #581 is building. The question is whether you build them in application code or get them from the runtime.

| What you need | Who's reinventing it | OTP primitive |
| :--- | :--- | :--- |
| Isolated agent state | LangGraph, AutoGen 0.4, CrewAI, `HarnessService` | GenServer |
| Message passing | Langroid, AutoGen 0.4, `harnessWs` protocol | `send` / `receive` |
| Crash recovery | Checkpoints, try/except, _missing_ | Supervisor |
| Event projection | State reducers, `projector.ts` | ETS + GenServer |
| Memory isolation | asyncio (shared), V8 shared heap | Process heaps |
| Lifecycle management | Runtime registry, `HarnessService` | DynamicSupervisor |

Framework analysis via [Guimarães (2026)](https://www.yourstack.com/george-guimaraes/your-agent-framework-is-just-a-bad-clone-of-elixir).

Guimarães argues that you can get about 70% of the way there with enough engineering — the remaining 30%, which includes preemptive scheduling, per-process garbage collection, and true fault isolation, requires runtime-level support.

Guimarães [later qualified this claim](https://www.yourstack.com/george-guimaraes/elixir-beam-doesnt-solve-everything-for-ai-agents), noting that the BEAM's advantages vary by workload and honestly naming the ecosystem gaps (immature LLM tooling, smaller talent pool, Python/Node-first SDKs). For T3Code specifically — a desktop tool, not a server — two of the four properties he cites (preemptive scheduling, hot code swapping) don't meaningfully apply. The two that do — per-process garbage collection and true fault isolation — are the ones this exploration focuses on.

The `HarnessService` pattern is that 70%. It gives you centralized lifecycle, event projection, and a unified contract. What it can't give you — because Node's V8 doesn't support it — is per-session crash isolation and independent memory containment. That's the 30% that an OTP layer fills.

## The proposed boundary

| Concern | Owner | Status |
| :--- | :--- | :--- |
| Agent SDK access (Claude, Codex) | Node | stays |
| Canonical event types + contracts | Node (TypeScript) | stays |
| SQLite persistence | Node | stays |
| Browser / Electron WebSocket | Node | stays |
| Provider process supervision | Elixir (OTP) | new |
| Crash isolation | Elixir (BEAM heaps) | new |
| Per-session memory containment | Elixir (process heaps) | new |
| Event normalization | Elixir | new |
| Event projection + snapshot | Both | shared |

## The isolation argument

When you run 4+ concurrent agent sessions — especially with subagents — the V8 shared heap becomes a liability. One leaky or crashing session affects every other session sharing that process. OTP's per-process heaps make this structurally impossible.

## Stress test results

8 test types, single-run results framed as architectural demonstrations — not statistical claims. The structural properties (per-process heaps, supervision cleanup) are BEAM guarantees, not observations.

| Metric | Node (V8) | Elixir (BEAM) |
| :--- | :--- | :--- |
| Heap with 1 leaky session | 48 → 158 MB (+110 MB shared heap) | Leak bounded per-process (94–352 KB) |
| Relative memory growth | ~229% heap growth | ~2% total memory growth |
| p99 event loop lag during leak | 169 ms | Not applicable (per-process GC) |
| Sibling sessions affected | All (shared heap) | 0 (isolated heaps) |

The contrast: Node's single leaky session grew the shared heap by 110 MB and added 169ms of p99 event loop lag across all sessions. Under the same leak, BEAM's total memory moved ~2% — the leak was contained to a single process heap between 94 and 352 KB, invisible to sibling sessions.

### The crossover point

We scaled concurrent sessions from 5 to 200, all streaming simultaneously. From 5 to 100, both runtimes are functionally identical — you would not be able to tell them apart. At 150, Node's event loop lag creeps to 199ms. At 200, Node degrades sharply: latency jumps to 3.3 seconds, throughput _drops_ (the event loop is so saturated it processes fewer events, not more), and event loop lag hits 1.2 seconds. Elixir at 200 sessions: 607ms latency, 18,000 events/sec, near-zero scheduler utilization, constant ~268 KB per session.

This is the number that matters: if T3Code stays at 1–10 sessions, PR #581's Node approach is simpler and sufficient. If it grows into a control plane with subagent orchestration at scale, the structural advantage materializes around 150 sessions — and it's not gradual. It's a cliff.

### Real workload: 10 subagents across 2 sessions

Codex in plan mode spawned 10 real subagents. Node oscillated 1.8–54 MB on the shared heap. Elixir held 54–63 MB flat while processing 14,918 events and 824 tool calls. Both completed all work — the difference is in predictability under load.

### Honest scorecard

Elixir wins on isolation, observability, and per-session memory attribution. Node wins on raw throughput and SDK ecosystem access. Hence: two runtimes, each handling what it does best.

## What adding a new provider costs

Adding a new provider to T3Code today means writing a TypeScript adapter, extending the contracts, adding tests, and wiring it through the orchestration layer. PR #1355 (Cursor ACP) is a representative example of that end-to-end cost.

In the OTP architecture, providers that speak a CLI or HTTP protocol (and don't require a Node-specific SDK) can be added as a single GenServer module + a clause in `SessionManager.provider_module/1`, with no changes to the Node side. For providers that _do_ require Node SDKs — Claude (Agent SDK) and Codex (app server) today — the Node adapter is still necessary. The OTP layer manages supervision and lifecycle, but the SDK call itself stays in Node.

The savings are real but scoped: the more providers that communicate via standard protocols (CLI, HTTP, WebSocket), the more the OTP architecture reduces per-provider integration cost. For SDK-gated providers, both sides need code.

## Why subagents change the calculus

If T3Code stayed a one-agent-at-a-time tool, I would not push hard for Elixir. Subagents change the math. Imagine a future session:

```
Parent task
  → Codex subagent for implementation
  → OpenCode subagent for search
  → Claude subagent for synthesis
```

Now ask the annoying questions:

- What happens if one subagent crashes mid-turn?
- What happens if one subagent is blocked on approval while another keeps streaming?
- What happens if the parent cancels and all children must stop cleanly?
- What happens if one child leaks memory or gets wedged on reconnect?

A Node-only architecture can answer all of them — but it answers them behaviorally: careful process accounting, careful cleanup chains, careful shared-state discipline. OTP answers them structurally: each subagent is a GenServer under a `DynamicSupervisor`, parent crash cascades to children via process links, one child's memory leak is contained to its own heap, and restart policies are declarative, not imperative.

The more autonomous and unpredictable agents become, the stronger this argument gets. "Start child, monitor child, restart child, stop subtree" stop being architecture words. They become the product.

## Honest tradeoffs

**BEAM runtime adds ~60–80 MB to the Electron bundle.** That's real. For a desktop app, it matters. The counter-argument is that with 4+ concurrent sessions running subagents, you're already in "supervise a tree of unstable runtimes" territory — and that's literally what OTP was designed for. But the bundle size cost is worth acknowledging upfront.

**It's a second runtime to maintain.** The Elixir ecosystem is smaller than Node's. Hiring is harder. The mitigation is that the OTP layer is intentionally thin (total ~3,900 LOC across all modules) — it does one thing well and delegates everything else to Node.

**The bridge WebSocket is an additional failure surface.** In the Node-only approach, events flow directly — no bridge, no extra hop. With the harness, there's a Phoenix Channel between Elixir and Node. That adds ~1ms of latency (invisible for most operations) but also a real failure mode: if the bridge drops during a streaming turn, events are lost until reconnection. The WAL ring buffer mitigates this with replay, but the failure mode does not exist in a single-runtime design.

**Cross-runtime debugging is objectively harder.** When something fails in Node, you get a continuous stack trace. With the harness, an error can start in Elixir (GenServer crash), manifest in Node (bridge disconnect), and surface in the browser (events stop). Two log systems, two debuggers. This is a cost that compounds over time if the boundary isn't sharp.

**The Agent SDK constraint is real and permanent.** As long as Anthropic gates subscription-based Claude Code access through their Node SDK, Claude and Codex must route through Node. The OTP layer manages the provider process lifecycle, but the SDK call itself stays in the Node adapter. This is a feature, not a bug — it respects the ecosystem as it exists.

This fork is offered as an architectural exploration, not a merge request. The goal is to contribute to the discussion — and honestly, to learn from it. Theo has more experience shipping Node + Electron at scale than most people writing about this topic. If this whole OTP angle is an over-engineered solution to a problem that doesn't materialize in practice, that's a genuinely useful answer. The worst outcome isn't "no" — it's building something nobody pressure-tested with someone who's shipped this at scale.

[View the fork on GitHub](https://github.com/Ranvier-Technologies/t3code-OTP)

## Addendum: failure scenario scorecard

We compared both approaches across ten concrete failure scenarios. Not benchmarks — failure scenarios. Because the OTP argument is not about throughput. It's about what happens when things go wrong.

| # | Scenario | Node | Elixir | Winner |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Provider CLI hangs | Session stale, others unaffected | GenServer stale, others unaffected | tie |
| 2 | Provider CLI crashes | `child.on("exit")` cleans up | Port exit handled, supervisor cleanup | tie |
| 3 | Memory leak in one session | Shared heap +110 MB, lag +169ms p99 | Leak bounded per-process (94–352 KB) | elixir |
| 4 | Unhandled exception | 5/5 survivors continue | 5/5 survivors continue | tie |
| 5 | 50+ concurrent sessions | Degrades sharply at ~150 (3.3s p99 at 200) | 607ms at 200, near-zero scheduler util | elixir |
| 6 | Process spawn/teardown churn | OS handles it | Port + process links, similar | tie |
| 7 | Subagent trees | Manual parent-child tracking | DynamicSupervisor, process links | elixir |
| 8 | Bridge WebSocket disconnect | Does not exist — events flow directly | Events lost until reconnection | node |
| 9 | Development complexity | One language, one debugger | Two languages, cross-runtime debugging | node |
| 10 | Desktop packaging | Electron bundles Node, zero extra cost | +60–80 MB BEAM runtime | node |

**Score: Elixir 3, Node 3, Tie 4.** But the scores are not equal in weight. Elixir's wins (3, 5, 7) are the ones that scale worst if left unaddressed — memory coupling compounds over hours of use, event loop saturation hits a cliff at ~150 sessions, and subagent cleanup chains grow with tree depth. Node's wins (8, 9, 10) are present-tense shipping costs. Both are real. The question is which set of problems you'd rather have.

**A note on the "careful application code" failure class.** Macroscope's review of PR #581 found concrete instances worth examining. One is a logic bug independent of runtime choice: adapter-emitted events pass through `#publish` without re-sequencing, which can regress the global snapshot sequence — this would need fixing in Elixir too. But the other two are lifecycle-management concerns that OTP handles structurally: `shutdownSession` aborts the event stream before the adapter completes, potentially losing final `session.exited` events; and `attachSession` never calls `#startStreaming`, leaving attached sessions deaf to events. These are exactly the class of lifecycle gaps where a supervisor's declarative restart and shutdown policies eliminate entire categories of ordering bugs — not because the Node code is bad (it's early WIP and well-structured), but because managing concurrent session lifecycles through application code requires getting every edge case right manually. A supervisor doesn't have edge cases. It has a restart policy.

For the full analysis with crossover benchmarks, methodology notes, and adversarial review: [complete writeup](https://ranvier-technologies.github.io/t3code-OTP/).
