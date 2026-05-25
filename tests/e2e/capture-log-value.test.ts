/**
 * E2e — `ready_when.capture` extracts a log value and threads it into a
 * downstream service's env (Plan 4 Task 24 / LEV-373).
 *
 * Proves the end-to-end capture pipeline against the real `lich` binary:
 *
 *   1. An owned service (`tunnel_demo`) emits a URL on a log line. Its
 *      `ready_when.capture` extracts the URL into a named capture key.
 *   2. A downstream owned service (`consumer`) declares
 *      `depends_on: [tunnel_demo]` so it runs in a later topo level. The
 *      consumer's per-service `env` references
 *      `${owned.tunnel_demo.captured.listen_url}`, which interpolates the
 *      captured value at spawn time.
 *   3. The consumer's `cmd` echoes the env var to its log, then hangs.
 *      `ready_when.log_match` waits for that echo before declaring the
 *      consumer ready.
 *
 * If any link in the chain is broken (capture not extracted, captured values
 * not threaded into the per-service env, interpolation engine missing the
 * `owned.<X>.captured.<Y>` shape), `lich up` either fails the consumer's
 * ready evaluator or interpolates to an empty string — both observable in
 * the consumer's log file via `lich logs consumer`.
 *
 * Why a synthetic minimal yaml (not the dogfood-stack):
 *   - The dogfood-stack's `tunnel_demo` synthetic service is the right shape,
 *     but `lich up dev` brings postgres + api + web + tunnel_demo and runs
 *     the psql migrate/seed lifecycle. The capture pipeline doesn't need
 *     any of that — it only needs two owned services with a depends_on edge
 *     and a captured value crossing it.
 *   - A focused yaml (just tunnel_demo + consumer) brings the test down from
 *     "minutes with docker" to "seconds without". The synthetic shape mirrors
 *     the dogfood-stack's `tunnel_demo` (same regex, same cmd pattern) so the
 *     test stays representative of real usage.
 *   - Precedent: `tests/e2e/profiles-default.test.ts` uses the same
 *     `writeFileSync` synthetic-yaml pattern for tests where dogfood isn't
 *     load-bearing.
 *
 * Isolation:
 *   - Each test gets a fresh tmpdir + per-test `LICH_HOME` so nothing leaks
 *     between runs or into the user's real `~/.lich`.
 *   - `lich down` runs in teardown to release owned PIDs.
 *
 * Spec source: docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 4
 * ready_when.capture; section 5 lich exec env wiring).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLich } from "./helpers/lich.js";
import { readStateJson } from "./helpers/state.js";

// ---------------------------------------------------------------------------
// Build the binary up front (same pattern as the other e2e suites).
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lichBinary = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synthetic lich.yaml that exercises ONLY the capture pipeline:
 *
 *   - `tunnel_demo` emits a URL log line, ready_when.log_match fires on it,
 *     and ready_when.capture extracts the URL into `listen_url`.
 *   - `consumer` depends on `tunnel_demo` (so it runs in a later topo level
 *     after tunnel_demo's capture has populated). Its per-service `env`
 *     references `${owned.tunnel_demo.captured.listen_url}`. Its `cmd`
 *     echoes the resolved env var to its log; `ready_when.log_match` waits
 *     for that echo so the up only succeeds if the captured value reached
 *     the consumer's spawn env.
 *
 * The literal `http://localhost:54999` in tunnel_demo's cmd is deliberate:
 * the capture demonstrates the regex extraction, not dynamic port allocation
 * — we want a stable expected value the test can assert on byte-for-byte.
 */
const CAPTURE_YAML = `version: "1"
owned:
  tunnel_demo:
    cmd: 'echo "starting"; sleep 0.3; echo "Listening on http://localhost:54999 (demo)"; sleep 99999'
    ready_when:
      log_match: "Listening on"
      capture:
        listen_url: "http://localhost:\\\\d+"

  consumer:
    cmd: 'echo "CONSUMER_TUNNEL_DEMO_URL=\${TUNNEL_DEMO_URL}"; sleep 99999'
    depends_on: [tunnel_demo]
    env:
      TUNNEL_DEMO_URL: "\${owned.tunnel_demo.captured.listen_url}"
    ready_when:
      log_match: "CONSUMER_TUNNEL_DEMO_URL="
`;

/** Find the single stack id under <LICH_HOME>/stacks/ (or null if missing). */
function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot);
  if (entries.length === 0) return null;
  return entries[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ready_when.capture threads a log value into a downstream service (Plan 4 Task 24)", () => {
  it(
    "consumer's per-service env interpolates ${owned.tunnel_demo.captured.listen_url}",
    () => {
      // ---- arrange: tmpdir + per-test LICH_HOME ---------------------------
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-capture-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-capture-home-"));

      // Use try/finally to guarantee teardown — `lich down` releases owned
      // PIDs even when an assertion fails mid-test, and the tmpdirs go away
      // so no debris leaks to subsequent runs.
      try {
        writeFileSync(join(dir, "lich.yaml"), CAPTURE_YAML, "utf8");

        // ---- act: lich up -------------------------------------------------
        // Synthetic config: just two owned services running `echo + sleep`.
        // No docker, no compile step, no network — the entire pipeline
        // should resolve within a few seconds. 60s is generous headroom for
        // a cold-cache binary spawn on a busy machine.
        //
        // `--no-browser` suppresses the daemon's auto-open side effect.
        // The daemon still spawns (it must, for the proxy to bind) but no
        // Chrome tab pops up — matches the fast-pool convention applied
        // across the migrated suite.
        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          // Surface stdout+stderr so a failed up gives the test author
          // something concrete to debug. Empty bodies are tolerated — the
          // assertion below will surface the missing context anyway.
          // eslint-disable-next-line no-console
          console.error("lich up stdout:\n" + upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up stderr:\n" + upResult.stderr);
        }
        // If `up` exits non-zero, the capture pipeline broke somewhere:
        //   - tunnel_demo never became ready (log_match didn't fire)
        //   - tunnel_demo's capture regex didn't match (CaptureMissError)
        //   - consumer's env interpolation failed (InterpolationError on
        //     `${owned.tunnel_demo.captured.listen_url}`)
        //   - consumer's ready_when.log_match never fired (env var empty)
        // Any of these surfaces here as a non-zero exit.
        expect(
          upResult.exitCode,
          `lich up should succeed; stderr was:\n${upResult.stderr}`,
        ).toBe(0);

        // ---- assert (1): consumer's log contains the captured URL -------
        // Read the consumer's log via `lich logs consumer --no-follow`.
        // This is the load-bearing assertion: it proves the captured value
        // reached the consumer's spawn env. The literal URL
        // (`http://localhost:54999`) is what tunnel_demo emits; if the
        // capture pipeline broke, the env var would be empty and the line
        // would read `CONSUMER_TUNNEL_DEMO_URL=`.
        const logsResult = runLich(
          ["logs", "consumer", "--no-follow"],
          {
            cwd: dir,
            env: { LICH_HOME: home },
            timeout: 10_000,
          },
        );
        expect(logsResult.exitCode).toBe(0);
        expect(logsResult.stdout).toContain(
          "CONSUMER_TUNNEL_DEMO_URL=http://localhost:54999",
        );

        // ---- assert (2): state.json reflects both services as ready -----
        // The snapshot acts as the durable contract: up succeeded → every
        // started service transitioned to `ready`. If only `tunnel_demo`
        // is ready and `consumer` is `starting`/`failed`, the capture
        // pipeline got partway and we caught a real bug.
        const stackId = findStackId(home);
        expect(stackId).not.toBeNull();
        const snap = readStateJson(home, stackId!);
        expect(snap).not.toBeNull();
        const services = Object.fromEntries(
          snap!.services.map((s) => [s.name, s.state]),
        );
        expect(services.tunnel_demo).toBe("ready");
        expect(services.consumer).toBe("ready");
      } finally {
        // Best-effort teardown — release the two owned PIDs (echo+sleep
        // hangs) so subsequent tests don't see leftover processes. `lich
        // down` is idempotent; ignore exit code.
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    /* timeout */ 90_000,
  );
});
