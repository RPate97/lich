#!/usr/bin/env bun
// Warm-fork benchmark — measures `lich up` cold-boot vs warm-fork time
// for the dogfood-stack dev:heavy profile (500 migrations + ~50k rows).
//
// Usage:
//   bun packages/e2e/benchmarks/warm-fork-bench.ts
//
// Env overrides:
//   LICH        - path to lich binary (default: packages/lich/dist/lich)
//   BENCH_RUNS  - warm-fork runs to average (default: 3)
//   BENCH_KEEP  - "1" to keep the tmp stack dir on exit (default: clean up)

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const LICH = process.env.LICH ?? join(repoRoot, "packages", "lich", "dist", "lich");
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const KEEP_TMP = process.env.BENCH_KEEP === "1";
const PROFILE = "dev:heavy";
const SANDBOX_IMAGE = "lich-sandbox-base";

const resultsDir = join(here, "results");
const resultsPath = join(resultsDir, `${isoDate()}-warm-fork-v0.md`);

function isoDate(): string {
  // Avoid Math.random/Date.now/new Date() flake in workflow contexts —
  // the spawned-process scripts.
  return new Date().toISOString().slice(0, 10);
}

function log(line: string): void {
  process.stdout.write(line + "\n");
}

function prepareStack(): string {
  const tmp = mkdtempSync(join(tmpdir(), "lich-bench-"));
  log(`tmp dir: ${tmp}`);
  cpSync(join(repoRoot, "packages", "e2e", "fixtures", "dogfood-stack"), join(tmp, "stack"), { recursive: true });
  const stackPath = join(tmp, "stack");

  // Generate the heavy migrations the fixture script puts under db/migrations-heavy.
  log("generating 500 synthetic migrations...");
  execFileSync("bash", ["scripts/generate-heavy-migrations.sh"], { cwd: stackPath, stdio: "inherit" });

  // Inject a sandbox block under runtime: into lich.yaml. The fixture's
  // existing runtime: section is small so we patch with a string replace.
  const yamlPath = join(stackPath, "lich.yaml");
  const original = readFileSync(yamlPath, "utf8");
  const sandboxBlock = [
    "  # Bench injection: route through Tart microVM with warm-fork.",
    "  sandbox:",
    `    backend: tart`,
    `    image: ${SANDBOX_IMAGE}`,
    "    warm_fork: true",
    "    bake_inputs:",
    '      - "lich.yaml"',
    "",
  ].join("\n");
  if (!original.includes("\nruntime:\n")) {
    throw new Error("dogfood-stack lich.yaml does not have a runtime: block; aborting");
  }
  const patched = original.replace(/\nruntime:\n/, "\nruntime:\n" + sandboxBlock);
  writeFileSync(yamlPath, patched, "utf8");

  return stackPath;
}

function purgeBeforeColdRun(stackPath: string): void {
  // Best-effort: ensure no stale run VM / snapshot for our profile.
  spawnSync(LICH, ["down", PROFILE, "--purge"], { cwd: stackPath, stdio: "inherit" });
  spawnSync(LICH, ["sandbox", "purge", "--yes"], { cwd: stackPath, stdio: "inherit" });
}

function purgeBetweenRuns(stackPath: string): void {
  // Drop the run VM but keep the snapshot — that's what makes the next up
  // a warm-fork instead of a cold-boot.
  spawnSync(LICH, ["down", PROFILE, "--purge"], { cwd: stackPath, stdio: "inherit" });
}

function timeLichUp(stackPath: string, label: string): number {
  const t0 = performance.now();
  const r = spawnSync(LICH, ["up", PROFILE], { cwd: stackPath, stdio: "inherit", timeout: 600_000 });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 0) {
    throw new Error(`${label}: lich up exited ${r.status} after ${ms}ms`);
  }
  log(`${label}: ${ms}ms (${(ms / 1000).toFixed(2)}s)`);
  return ms;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main(): Promise<void> {
  log(`warm-fork benchmark`);
  log(`lich: ${LICH}`);
  log(`profile: ${PROFILE}`);
  log(`warm runs: ${RUNS}`);

  const stack = prepareStack();
  try {
    log("\n=== Cold boot ===");
    purgeBeforeColdRun(stack);
    const coldMs = timeLichUp(stack, "cold");

    const warmMs: number[] = [];
    for (let i = 1; i <= RUNS; i++) {
      log(`\n=== Warm-fork run ${i}/${RUNS} ===`);
      purgeBetweenRuns(stack);
      const ms = timeLichUp(stack, `warm[${i}]`);
      warmMs.push(ms);
    }

    // Final teardown.
    spawnSync(LICH, ["down", PROFILE, "--purge"], { cwd: stack, stdio: "inherit" });

    const avgWarm = Math.round(warmMs.reduce((a, b) => a + b, 0) / warmMs.length);
    const minWarm = Math.min(...warmMs);
    const maxWarm = Math.max(...warmMs);
    const speedup = coldMs / avgWarm;

    log(`\n=== SUMMARY ===`);
    log(`Cold:     ${fmt(coldMs)}`);
    log(`Warm avg: ${fmt(avgWarm)}  (min ${fmt(minWarm)}, max ${fmt(maxWarm)})`);
    log(`Speedup:  ${speedup.toFixed(1)}x`);

    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      resultsPath,
      [
        `# Warm-Fork V0 Benchmark`,
        ``,
        `- Host: ${process.platform} ${process.arch}, ${hostname()}`,
        `- Substrate: Tart on macOS Virtualization.framework`,
        `- Image: ${SANDBOX_IMAGE}`,
        `- Stack: dogfood-stack ${PROFILE} (postgres + 500 synthetic migrations)`,
        `- Warm runs: ${RUNS}`,
        ``,
        `## Headline`,
        ``,
        `| Metric        | Time |`,
        `|---------------|------|`,
        `| Cold boot     | ${fmt(coldMs)} |`,
        `| Avg warm-fork | ${fmt(avgWarm)} |`,
        `| **Speedup**   | **${speedup.toFixed(1)}x** |`,
        ``,
        `## Raw timings`,
        ``,
        `- Cold: ${coldMs}ms`,
        warmMs.map((ms, i) => `- Warm[${i + 1}]: ${ms}ms`).join("\n"),
        ``,
        `## Method`,
        ``,
        `1. Copy dogfood-stack fixture to a fresh tmp dir.`,
        `2. Generate 500 synthetic migrations via fixtures/dogfood-stack/scripts/generate-heavy-migrations.sh.`,
        `3. Inject \`runtime.sandbox\` block (backend: tart, image: ${SANDBOX_IMAGE}, warm_fork: true).`,
        `4. \`lich sandbox purge\` + \`lich down --purge\` to wipe any prior state.`,
        `5. Time \`lich up ${PROFILE}\` (cold-boot path). VM gets created, source synced in, migrations applied, snapshot taken on success.`,
        `6. Repeat ${RUNS} times: \`lich down --purge\` (drops run VM, keeps snapshot), then time \`lich up ${PROFILE}\` (warm-fork path: clones snapshot, resumes).`,
        ``,
        `Each \`lich up\` invocation is wall-clock timed from CLI invocation to exit.`,
      ].join("\n") + "\n",
      "utf8",
    );
    log(`\nresults written: ${resultsPath}`);
  } finally {
    if (!KEEP_TMP) {
      rmSync(stack, { recursive: true, force: true });
    } else {
      log(`(BENCH_KEEP=1; tmp dir preserved: ${stack})`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
