#!/usr/bin/env bun
/**
 * benchmark-analyze.ts — Analysis pipeline for OTP crossover benchmarks.
 *
 * Reads benchmark JSON results, pairs Node/Elixir data at each step,
 * detects crossover points, and outputs:
 *   1. Markdown report with side-by-side tables
 *   2. CSV files for charting (one per benchmark)
 *   3. Crossover summary
 *
 * Usage:
 *   bun run scripts/benchmark-analyze.ts
 *   bun run scripts/benchmark-analyze.ts --dir=output/stress-test
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUTPUT_DIR =
  process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1] ||
  `${process.cwd()}/output/stress-test`;

const BENCHMARKS = [
  "session-ramp",
  "payload-ramp",
  "subagent-ramp",
  "failure-storm",
  "sustained-leak",
];

const BENCHMARK_LABELS: Record<string, string> = {
  "session-ramp": "Session Count Ramp",
  "payload-ramp": "Payload Size Ramp (Noisy Neighbor)",
  "subagent-ramp": "Subagent Tree Width Ramp",
  "failure-storm": "Failure Storm Under Load",
  "sustained-leak": "Sustained Leak Over Time",
};

const BENCHMARK_UNITS: Record<string, string> = {
  "session-ramp": "sessions",
  "payload-ramp": "KB",
  "subagent-ramp": "parent sessions",
  "failure-storm": "simultaneous crashes",
  "sustained-leak": "healthy sessions",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkStep {
  benchmark: string;
  runtime: "node" | "elixir";
  step: number;
  stepLabel: string;
  metrics: Record<string, number | null>;
  timeSeries?: Array<Record<string, number>>;
}

interface BenchmarkResult {
  benchmark: string;
  runtime: string;
  steps: BenchmarkStep[];
  [key: string]: unknown;
}

interface Crossover {
  benchmark: string;
  metric: string;
  stepValue: number;
  stepLabel: string;
  nodeValue: number;
  elixirValue: number;
  ratio: number;
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

function parseResultFile(path: string): BenchmarkResult | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Handle both formats: array of BenchmarkStep[] or {steps: BenchmarkStep[]}
    if (Array.isArray(raw)) {
      const steps = raw as BenchmarkStep[];
      return {
        benchmark: steps[0]?.benchmark ?? "unknown",
        runtime: steps[0]?.runtime ?? "unknown",
        steps,
      };
    }
    // If it has a steps property, use directly
    if (raw.steps && Array.isArray(raw.steps)) {
      return raw as BenchmarkResult;
    }
    // If it's a single step object, wrap it
    if (raw.benchmark && raw.metrics) {
      return {
        benchmark: raw.benchmark,
        runtime: raw.runtime,
        steps: [raw],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function loadLatestResults(): Map<
  string,
  { node: BenchmarkResult | null; elixir: BenchmarkResult | null }
> {
  const files = readdirSync(OUTPUT_DIR).filter(
    (f) => f.startsWith("benchmark-") && f.endsWith(".json"),
  );

  // Group by benchmark name, find latest per runtime
  const grouped = new Map<string, { node: string | null; elixir: string | null }>();

  for (const bench of BENCHMARKS) {
    const nodeFiles = files
      .filter((f) => f.startsWith(`benchmark-${bench}-node-`))
      .sort()
      .reverse();
    const elixirFiles = files
      .filter((f) => f.startsWith(`benchmark-${bench}-elixir-`))
      .sort()
      .reverse();

    grouped.set(bench, {
      node: nodeFiles[0] ?? null,
      elixir: elixirFiles[0] ?? null,
    });
  }

  const results = new Map<
    string,
    { node: BenchmarkResult | null; elixir: BenchmarkResult | null }
  >();

  for (const [bench, { node, elixir }] of grouped) {
    results.set(bench, {
      node: node ? parseResultFile(`${OUTPUT_DIR}/${node}`) : null,
      elixir: elixir ? parseResultFile(`${OUTPUT_DIR}/${elixir}`) : null,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Crossover detection
// ---------------------------------------------------------------------------

function detectCrossover(
  nodeSteps: BenchmarkStep[],
  elixirSteps: BenchmarkStep[],
  metric: string,
  higherIsWorse: boolean = true,
): Crossover | null {
  // Find common steps
  const nodeByStep = new Map(nodeSteps.map((s) => [s.step, s]));
  const elixirByStep = new Map(elixirSteps.map((s) => [s.step, s]));

  const commonSteps = [...nodeByStep.keys()]
    .filter((k) => elixirByStep.has(k))
    .sort((a, b) => a - b);

  if (commonSteps.length < 2) return null;

  // Find first step where Elixir is better than Node
  for (const step of commonSteps) {
    const nodeVal = nodeByStep.get(step)!.metrics[metric];
    const elixirVal = elixirByStep.get(step)!.metrics[metric];

    if (nodeVal == null || elixirVal == null) continue;

    const elixirBetter = higherIsWorse
      ? elixirVal < nodeVal * 0.8 // Elixir is 20%+ better
      : elixirVal > nodeVal * 1.2; // Elixir is 20%+ better (higher is better)

    if (elixirBetter) {
      return {
        benchmark: nodeByStep.get(step)!.benchmark,
        metric,
        stepValue: step,
        stepLabel: nodeByStep.get(step)!.stepLabel,
        nodeValue: nodeVal,
        elixirValue: elixirVal,
        ratio: nodeVal / (elixirVal || 1),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function generateCSV(
  nodeSteps: BenchmarkStep[],
  elixirSteps: BenchmarkStep[],
  benchName: string,
): string {
  const nodeByStep = new Map(nodeSteps.map((s) => [s.step, s]));
  const elixirByStep = new Map(elixirSteps.map((s) => [s.step, s]));

  const allSteps = [...new Set([...nodeByStep.keys(), ...elixirByStep.keys()])].sort(
    (a, b) => a - b,
  );

  // Collect all metric keys
  const metricKeys = new Set<string>();
  for (const s of [...nodeSteps, ...elixirSteps]) {
    for (const k of Object.keys(s.metrics)) metricKeys.add(k);
  }
  const sortedKeys = [...metricKeys].sort();

  // Header
  const headers = ["step", "step_label"];
  for (const k of sortedKeys) {
    headers.push(`node_${k}`, `elixir_${k}`);
  }

  const rows = [headers.join(",")];

  for (const step of allSteps) {
    const n = nodeByStep.get(step);
    const e = elixirByStep.get(step);
    const label = n?.stepLabel ?? e?.stepLabel ?? String(step);

    const row = [String(step), `"${label}"`];
    for (const k of sortedKeys) {
      row.push(
        n?.metrics[k] != null ? String(n.metrics[k]) : "",
        e?.metrics[k] != null ? String(e.metrics[k]) : "",
      );
    }
    rows.push(row.join(","));
  }

  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Time series CSV (for sustained-leak)
// ---------------------------------------------------------------------------

function generateTimeSeriesCSV(nodeSteps: BenchmarkStep[], elixirSteps: BenchmarkStep[]): string {
  const rows: string[] = [];

  // For each step (healthy count variant), emit time series rows
  for (const nStep of nodeSteps) {
    const eStep = elixirSteps.find((s) => s.step === nStep.step);
    if (!nStep.timeSeries?.length) continue;

    const tsKeys = new Set<string>();
    for (const ts of [...(nStep.timeSeries ?? []), ...(eStep?.timeSeries ?? [])]) {
      for (const k of Object.keys(ts)) tsKeys.add(k);
    }
    const sortedKeys = [...tsKeys].filter((k) => k !== "elapsed_ms").sort();

    if (rows.length === 0) {
      // Header
      const headers = ["healthy_count", "elapsed_ms"];
      for (const k of sortedKeys) headers.push(`node_${k}`, `elixir_${k}`);
      rows.push(headers.join(","));
    }

    const nodeByTime = new Map((nStep.timeSeries ?? []).map((t) => [t.elapsed_ms, t]));
    const elixirByTime = new Map((eStep?.timeSeries ?? []).map((t) => [t.elapsed_ms, t]));
    const allTimes = [...new Set([...nodeByTime.keys(), ...elixirByTime.keys()])].sort(
      (a, b) => (a ?? 0) - (b ?? 0),
    );

    for (const t of allTimes) {
      const nt = nodeByTime.get(t);
      const et = elixirByTime.get(t);
      const row = [String(nStep.step), String(t)];
      for (const k of sortedKeys) {
        row.push(nt?.[k] != null ? String(nt[k]) : "", et?.[k] != null ? String(et[k]) : "");
      }
      rows.push(row.join(","));
    }
  }

  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function fmt(val: number | null | undefined, decimals: number = 1): string {
  if (val == null) return "—";
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (Math.abs(val) >= 10_000) return `${(val / 1000).toFixed(1)}K`;
  return val.toFixed(decimals);
}

function fmtBytes(val: number | null | undefined): string {
  if (val == null) return "—";
  if (val >= 1_073_741_824) return `${(val / 1_073_741_824).toFixed(1)}GB`;
  if (val >= 1_048_576) return `${(val / 1_048_576).toFixed(1)}MB`;
  if (val >= 1024) return `${(val / 1024).toFixed(1)}KB`;
  return `${val}B`;
}

function generateMarkdown(
  results: Map<string, { node: BenchmarkResult | null; elixir: BenchmarkResult | null }>,
  crossovers: Crossover[],
): string {
  const lines: string[] = [];

  lines.push("# OTP Crossover Benchmark Results");
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");

  // ---------------------------------------------------------------------------
  // Crossover summary
  // ---------------------------------------------------------------------------

  lines.push("## Crossover Summary");
  lines.push("");

  if (crossovers.length === 0) {
    lines.push(
      "No crossover points detected (Elixir may not yet outperform Node at tested scales, or both runtimes performed similarly).",
    );
  } else {
    lines.push("| Benchmark | Metric | Crossover At | Node | Elixir | Ratio |");
    lines.push("|-----------|--------|-------------|------|--------|-------|");
    for (const c of crossovers) {
      lines.push(
        `| ${c.benchmark} | ${c.metric} | ${c.stepLabel} | ${fmt(c.nodeValue)} | ${fmt(c.elixirValue)} | ${c.ratio.toFixed(1)}x |`,
      );
    }
  }
  lines.push("");

  // ---------------------------------------------------------------------------
  // Per-benchmark tables
  // ---------------------------------------------------------------------------

  for (const benchName of BENCHMARKS) {
    const data = results.get(benchName);
    if (!data) continue;

    const label = BENCHMARK_LABELS[benchName] ?? benchName;
    const unit = BENCHMARK_UNITS[benchName] ?? "step";

    lines.push(`## ${label}`);
    lines.push("");

    const hasNode = data.node && data.node.steps?.length > 0;
    const hasElixir = data.elixir && data.elixir.steps?.length > 0;

    if (!hasNode && !hasElixir) {
      lines.push("_No data available._");
      lines.push("");
      continue;
    }

    // Build comparison table
    const nodeByStep = new Map((data.node?.steps ?? []).map((s) => [s.step, s]));
    const elixirByStep = new Map((data.elixir?.steps ?? []).map((s) => [s.step, s]));
    const allSteps = [...new Set([...nodeByStep.keys(), ...elixirByStep.keys()])].sort(
      (a, b) => a - b,
    );

    // Primary metrics table
    lines.push(
      `| ${unit} | Node Latency P99 | Elixir Latency P99 | Node Memory | Elixir Memory | Node Throughput | Elixir Throughput | Correctness |`,
    );
    lines.push(
      "|--------|-----------------|-------------------|-------------|--------------|----------------|------------------|-------------|",
    );

    for (const step of allSteps) {
      const n = nodeByStep.get(step);
      const e = elixirByStep.get(step);

      lines.push(
        `| ${step} | ${fmt(n?.metrics.latency_p99_ms)}ms | ${fmt(e?.metrics.latency_p99_ms)}ms | ${fmtBytes(n?.metrics.memory_bytes)} | ${fmtBytes(e?.metrics.memory_bytes)} | ${fmt(n?.metrics.throughput_events_per_sec, 0)}e/s | ${fmt(e?.metrics.throughput_events_per_sec, 0)}e/s | ${fmt(n?.metrics.correctness_pct, 0)}%/${fmt(e?.metrics.correctness_pct, 0)}% |`,
      );
    }
    lines.push("");

    // Runtime-specific metrics
    if (hasNode) {
      lines.push("**Node event loop lag:**");
      lines.push("");
      lines.push(`| ${unit} | Lag P50 | Lag P99 |`);
      lines.push("|--------|---------|---------|");
      for (const step of allSteps) {
        const n = nodeByStep.get(step);
        if (!n) continue;
        lines.push(
          `| ${step} | ${fmt(n.metrics.latency_p50_ms)}ms | ${fmt(n.metrics.event_loop_lag_p99_ms)}ms |`,
        );
      }
      lines.push("");
    }

    if (hasElixir) {
      lines.push("**Elixir per-process metrics:**");
      lines.push("");
      lines.push(`| ${unit} | Per-Session Memory | Scheduler Util |`);
      lines.push("|--------|--------------------|----------------|");
      for (const step of allSteps) {
        const e = elixirByStep.get(step);
        if (!e) continue;
        lines.push(
          `| ${step} | ${fmtBytes(e.metrics.per_session_memory_bytes)} | ${e.metrics.scheduler_util_avg != null ? (e.metrics.scheduler_util_avg * 100).toFixed(1) + "%" : "—"} |`,
        );
      }
      lines.push("");
    }

    // Benchmark-specific extras
    if (benchName === "subagent-ramp") {
      lines.push("**Subagent integrity & fairness:**");
      lines.push("");
      lines.push(
        `| ${unit} | Node Integrity | Elixir Integrity | Node Fairness σ | Elixir Fairness σ |`,
      );
      lines.push(
        "|--------|----------------|-----------------|-----------------|-------------------|",
      );
      for (const step of allSteps) {
        const n = nodeByStep.get(step);
        const e = elixirByStep.get(step);
        lines.push(
          `| ${step} | ${fmt(n?.metrics.lifecycle_integrity_pct, 0)}% | ${fmt(e?.metrics.lifecycle_integrity_pct, 0)}% | ${fmt(n?.metrics.fairness_stddev)} | ${fmt(e?.metrics.fairness_stddev)} |`,
        );
      }
      lines.push("");
    }

    if (benchName === "failure-storm") {
      lines.push("**Crash impact on survivors:**");
      lines.push("");
      lines.push(
        `| Crashes | Node Lag Spike | Elixir Lag Spike | Node Errors | Elixir Errors | Node Cleanup | Elixir Cleanup |`,
      );
      lines.push(
        "|---------|---------------|-----------------|-------------|--------------|-------------|----------------|",
      );
      for (const step of allSteps) {
        const n = nodeByStep.get(step);
        const e = elixirByStep.get(step);
        lines.push(
          `| ${step} | ${fmt(n?.metrics.crash_lag_spike_ms)}ms | ${fmt(e?.metrics.crash_lag_spike_ms)}ms | ${fmt(n?.metrics.survivor_error_count, 0)} | ${fmt(e?.metrics.survivor_error_count, 0)} | ${fmtBytes(n?.metrics.memory_cleanup_bytes)} | ${fmtBytes(e?.metrics.memory_cleanup_bytes)} |`,
        );
      }
      lines.push("");
    }

    if (benchName === "sustained-leak") {
      lines.push("**Memory growth over time:**");
      lines.push("");
      lines.push(
        `| Healthy Sessions | Node Growth | Elixir Growth | Node Growth % | Elixir Growth % | Leak Deltas (Node) | Leak Deltas (Elixir) |`,
      );
      lines.push(
        "|-----------------|-------------|--------------|--------------|----------------|-------------------|---------------------|",
      );
      for (const step of allSteps) {
        const n = nodeByStep.get(step);
        const e = elixirByStep.get(step);
        lines.push(
          `| ${step} | ${fmtBytes(n?.metrics.memory_growth_bytes)} | ${fmtBytes(e?.metrics.memory_growth_bytes)} | ${fmt(n?.metrics.memory_growth_pct, 0)}% | ${fmt(e?.metrics.memory_growth_pct, 0)}% | ${fmt(n?.metrics.leak_deltas_received, 0)} | ${fmt(e?.metrics.leak_deltas_received, 0)} |`,
        );
      }
      lines.push("");
    }
  }

  // ---------------------------------------------------------------------------
  // The Answer
  // ---------------------------------------------------------------------------

  lines.push("## The Answer");
  lines.push("");

  if (crossovers.length > 0) {
    lines.push("Based on the benchmark data, the OTP crossover points are:");
    lines.push("");
    for (const c of crossovers) {
      lines.push(
        `- **${BENCHMARK_LABELS[c.benchmark] ?? c.benchmark}**: Elixir outperforms Node at **${c.stepLabel}** (${c.ratio.toFixed(1)}x better on ${c.metric})`,
      );
    }
    lines.push("");
    lines.push(
      "> The structural advantage of OTP becomes measurable when T3Code operates beyond these thresholds — which is the scale reached when it becomes a true multi-agent orchestrator with concurrent subagent trees.",
    );
  } else {
    lines.push(
      "The benchmarks did not detect a clear crossover point at the tested scales. This could mean:",
    );
    lines.push("");
    lines.push("- Both runtimes handle the tested scales equally well");
    lines.push("- The crossover occurs beyond the tested range");
    lines.push("- The workload characteristics need adjustment to surface the differences");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  OTP Crossover Benchmark Analysis                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const results = loadLatestResults();
  const csvDir = `${OUTPUT_DIR}/charts`;
  mkdirSync(csvDir, { recursive: true });

  let totalSteps = 0;
  const crossovers: Crossover[] = [];

  for (const [benchName, data] of results) {
    const hasData = (data.node?.steps?.length ?? 0) > 0 || (data.elixir?.steps?.length ?? 0) > 0;
    if (!hasData) {
      console.log(`  ○ ${benchName}: no data`);
      continue;
    }

    const nodeSteps = data.node?.steps ?? [];
    const elixirSteps = data.elixir?.steps ?? [];
    totalSteps += nodeSteps.length + elixirSteps.length;

    console.log(
      `  ● ${benchName}: node=${nodeSteps.length} steps, elixir=${elixirSteps.length} steps`,
    );

    // Generate CSV
    if (nodeSteps.length > 0 && elixirSteps.length > 0) {
      const csv = generateCSV(nodeSteps, elixirSteps, benchName);
      writeFileSync(`${csvDir}/benchmark-${benchName}.csv`, csv);
      console.log(`    → ${csvDir}/benchmark-${benchName}.csv`);

      // Time series CSV for sustained-leak
      if (benchName === "sustained-leak") {
        const tsCsv = generateTimeSeriesCSV(nodeSteps, elixirSteps);
        if (tsCsv.trim()) {
          writeFileSync(`${csvDir}/benchmark-${benchName}-timeseries.csv`, tsCsv);
          console.log(`    → ${csvDir}/benchmark-${benchName}-timeseries.csv`);
        }
      }

      // Detect crossovers
      const latencyCrossover = detectCrossover(nodeSteps, elixirSteps, "latency_p99_ms", true);
      if (latencyCrossover) crossovers.push(latencyCrossover);

      const memoryCrossover = detectCrossover(nodeSteps, elixirSteps, "memory_bytes", true);
      if (memoryCrossover) crossovers.push(memoryCrossover);

      const throughputCrossover = detectCrossover(
        nodeSteps,
        elixirSteps,
        "throughput_events_per_sec",
        false,
      );
      if (throughputCrossover) crossovers.push(throughputCrossover);
    }
  }

  if (totalSteps === 0) {
    console.log("\n  No benchmark data found. Run benchmarks first:");
    console.log("    bun run scripts/benchmark-runner.ts --runtime=both\n");
    process.exit(1);
  }

  // Generate markdown report
  const markdown = generateMarkdown(results, crossovers);
  const reportPath = `${OUTPUT_DIR}/benchmark-analysis.md`;
  writeFileSync(reportPath, markdown);
  console.log(`\n  Report: ${reportPath}`);

  // Print crossover summary
  if (crossovers.length > 0) {
    console.log("\n  Crossover points detected:");
    for (const c of crossovers) {
      console.log(`    ${c.benchmark} / ${c.metric}: at ${c.stepLabel} (${c.ratio.toFixed(1)}x)`);
    }
  } else {
    console.log("\n  No crossover points detected at tested scales.");
  }

  console.log(
    `\n  Total: ${totalSteps} data points across ${[...results.values()].filter((d) => d.node || d.elixir).length} benchmarks\n`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
