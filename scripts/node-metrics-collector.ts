#!/usr/bin/env bun
/**
 * node-metrics-collector.ts — V8/Node metrics collector for baseline comparison.
 *
 * Collects: process.memoryUsage(), event loop lag, active session count.
 * Writes JSON lines to stdout at 1-second intervals.
 *
 * STRUCTURAL LIMITATION: Node's shared V8 heap means per-session memory
 * attribution is impossible. This IS the key difference we're measuring.
 *
 * Usage:
 *   bun run scripts/node-metrics-collector.ts [duration_seconds=30] [output_file]
 *
 * Output format (one JSON object per line):
 * {
 *   timestamp: number,
 *   memory: { heapUsed, heapTotal, rss, external, arrayBuffers },
 *   eventLoopLag_ms: number,
 *   v8Heap: { totalHeapSize, usedHeapSize, heapSizeLimit, mallocedMemory },
 *   gc: { note: "per-session GC not available in V8 — shared heap" }
 * }
 */

import v8 from "node:v8";
import { writeFileSync, appendFileSync } from "node:fs";

const durationSeconds = Number(process.argv[2] || 30);
const outputFile = process.argv[3] || null;

interface MetricsSample {
  timestamp: number;
  elapsed_ms: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    arrayBuffers: number;
  };
  eventLoopLag_ms: number;
  v8Heap: {
    totalHeapSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
  };
  gc: {
    note: string;
    perSessionAvailable: false;
  };
}

// --- Event loop lag measurement ---
// Uses hrtime to measure how long a setTimeout(0) actually takes

function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setTimeout(() => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ns → ms
      // Subtract the expected 1ms setTimeout minimum
      resolve(Math.max(0, elapsed - 1));
    }, 1);
  });
}

// --- Collector ---

const t0 = Date.now();
const samples: MetricsSample[] = [];

if (outputFile) {
  writeFileSync(outputFile, ""); // truncate
}

console.error(`[node-metrics] Collecting for ${durationSeconds}s...`);

async function collectSample(): Promise<MetricsSample> {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const lag = await measureEventLoopLag();

  return {
    timestamp: Date.now(),
    elapsed_ms: Date.now() - t0,
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    eventLoopLag_ms: Math.round(lag * 100) / 100,
    v8Heap: {
      totalHeapSize: heapStats.total_heap_size,
      usedHeapSize: heapStats.used_heap_size,
      heapSizeLimit: heapStats.heap_size_limit,
      mallocedMemory: heapStats.malloced_memory,
    },
    gc: {
      note: "per-session GC not available in V8 — shared heap",
      perSessionAvailable: false,
    },
  };
}

let elapsed = 0;
const interval = setInterval(async () => {
  elapsed += 1;
  const sample = await collectSample();
  samples.push(sample);

  const line = JSON.stringify(sample);

  if (outputFile) {
    appendFileSync(outputFile, line + "\n");
  } else {
    console.log(line);
  }

  if (elapsed >= durationSeconds) {
    clearInterval(interval);
    console.error(
      `[node-metrics] Done. ${samples.length} samples collected. ` +
        `Peak RSS: ${(Math.max(...samples.map((s) => s.memory.rss)) / 1024 / 1024).toFixed(1)}MB, ` +
        `Peak heap: ${(Math.max(...samples.map((s) => s.memory.heapUsed)) / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}, 1000);
