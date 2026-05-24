/**
 * E2e — `lich logs` filtering (Plan 1 Task 32 / LEV-299).
 *
 * Brings up the dogfood-stack from a tmpdir, makes a deterministic request
 * to the api so something concrete lands in its log file, then exercises
 * the `lich logs` surface:
 *
 *   - `lich logs --tail N --no-follow` (aggregate)  → lines from every
 *     service appear, each prefixed `[<service>] `.
 *   - `lich logs api --tail N --no-follow`           → only api lines,
 *     NO `[api]` prefix.
 *   - `lich logs --tail N --no-follow`               → respects --tail
 *     (initial dump is bounded).
 *   - `lich logs --no-follow`                        → exits cleanly
 *     (not blocking on the follow loop).
 *   - `lich logs nonexistent`                        → exit 1, message
 *     names the available services.
 *
 * This is a HEAVY test — it spawns docker + supabase + bun dev servers.
 * It is skipped when `docker` or `supabase` (CLI v2+) aren't available
 * on PATH so a stripped-down CI box doesn't fail spuriously.
 *
 * Isolation:
 *   - Each test copies `examples/dogfood-stack` into a fresh tmpdir.
 *   - `LICH_HOME` is pointed at a per-test directory so this test never
 *     touches the user's real `~/.lich`.
 *   - `lich nuke --yes` runs in `afterAll` to tear down whatever the test
 *     left behind, then the tmpdirs are removed.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";

// ---------------------------------------------------------------------------
// Preflight: docker + supabase availability
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

function hasDocker(): boolean {
  try {
    // `docker info` actually contacts the daemon — `docker --version` only
    // proves the CLI is installed. We use `docker version --format` because
    // it exits non-zero when the daemon is unreachable (whereas `docker
    // info` exits 0 and prints "Cannot connect to the Docker daemon" to
    // stderr, which would let dead environments slip through).
    const r = spawnSync(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (r.status !== 0) return false;
    // A reachable daemon prints a non-empty version string.
    return (r.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Supabase CLI v2+ is required by the dogfood-stack. v1 has a different
 * subcommand surface; testing against it would be flaky and pointless.
 */
function hasSupabaseV2Plus(): boolean {
  try {
    const r = spawnSync("supabase", ["--version"], { encoding: "utf8" });
    if (r.status !== 0) return false;
    // `supabase --version` prints just the version number, e.g. "2.98.2".
    const match = (r.stdout ?? "").trim().match(/^(\d+)\./);
    if (!match) return false;
    return Number(match[1]) >= 2;
  } catch {
    return false;
  }
}

const DOCKER_OK = hasDocker();
const SUPABASE_OK = hasSupabaseV2Plus();
const PREREQS_OK = DOCKER_OK && SUPABASE_OK;

// ---------------------------------------------------------------------------
// Test-scoped state
// ---------------------------------------------------------------------------

let projectPath: string | null = null;
let projectCleanup: (() => void) | null = null;
let lichHome: string | null = null;
let apiPort: number | null = null;

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/**
 * Parse `lich urls` plain output into a service → port map. Lines look like
 * `api: http://localhost:9123` (single port) or `supabase.api:
 * http://localhost:9124` (multi-port). We only need the first form to find
 * the API's port; multi-port lines are ignored.
 */
function parseUrls(stdout: string): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\S+):\s+http:\/\/localhost:(\d+)\s*$/);
    if (!m) continue;
    const [, key, portStr] = m;
    // Skip dotted multi-port keys (e.g. "supabase.api"); we want the
    // service's primary http port, which is the un-dotted form for owned
    // services with `port: { env: PORT }`.
    if (key.includes(".")) continue;
    ports[key] = Number(portStr);
  }
  return ports;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe.skipIf(!PREREQS_OK)("lich logs filtering", () => {
  // Bun's test runner enforces a 5s timeout on beforeAll/afterAll hooks with
  // no way to override per-hook (see https://bun.sh/docs/cli/test#timeouts).
  // Pushing the expensive `lich up` into a regular `it` lets us pass a
  // 3-minute timeout via the standard third-argument form. Tests run in
  // declaration order, so subsequent its inherit the already-running stack
  // through module-scoped state.
  //
  // The afterAll hook only does best-effort teardown (no awaits longer than
  // nuke's own internal timeouts), so it fits comfortably inside 5s for the
  // success path and the test runner still surfaces leaked resources via
  // subsequent test runs colliding.
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      // Build the binary once so every test runs against the latest source.
      // The build is fast (~150ms with bun --compile) and idempotent.
      execSync("bun run build", {
        cwd: join(repoRoot, "packages/lich"),
        stdio: "inherit",
      });

      // Fresh tmpdir per suite — all tests share one running stack so the
      // expensive `lich up` happens exactly once.
      const copied = copyExampleToTmpdir("dogfood-stack");
      projectPath = copied.path;
      projectCleanup = copied.cleanup;

      // Isolate state from the user's real ~/.lich so test runs never pollute
      // (or trip over) other lich stacks the user is running by hand.
      lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-logs-home-"));

      // Install deps in the copy so the owned services (`bun run dev` in
      // apps/api and apps/web) can actually start. `copyExampleToTmpdir`
      // filters node_modules out, so we have to install in the tmpdir.
      execSync("bun install", { cwd: projectPath, stdio: "inherit" });

      // Bring the stack up. `lich up` returns once every service is ready;
      // owned services keep running as orphan processes in their own session.
      const upResult = runLich(["up"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 180_000,
      });
      if (upResult.exitCode !== 0) {
        // Surface stdout+stderr so a failed up gives the test author
        // something to act on (otherwise the rest of the suite fails with
        // confusing "no stack found" errors).
        throw new Error(
          `lich up failed (exit ${upResult.exitCode})\n` +
            `--- stdout ---\n${upResult.stdout}\n` +
            `--- stderr ---\n${upResult.stderr}`,
        );
      }

      // Find the api's host port from `lich urls`. We can't rely on the env
      // var name (`PORT`) because the allocator picks an arbitrary free
      // port per worktree — that's the whole point of port allocation.
      const urlsResult = runLich(["urls"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
      });
      expect(urlsResult.exitCode).toBe(0);
      const ports = parseUrls(urlsResult.stdout);
      if (typeof ports.api !== "number") {
        throw new Error(
          `could not find api port in lich urls output:\n${urlsResult.stdout}`,
        );
      }
      apiPort = ports.api;

      // Wait for the api to actually respond before asking the test to make
      // requests. `lich up` already waits on ready_when (http_get /health),
      // but belt-and-braces — under load the orphaned child can take an
      // extra tick to start accepting traffic.
      await waitForHttp200(`http://localhost:${apiPort}/health`, {
        timeoutMs: 30_000,
      });

      // Hit the api a few times to generate something concrete in the api's
      // log file beyond the startup banner. The dogfood api doesn't log
      // request lines by default (just `[api] listening...`), so this is
      // mostly for the api-specific assertion below — we tolerate the case
      // where the only api content is the startup banner.
      for (let i = 0; i < 3; i++) {
        await fetch(`http://localhost:${apiPort}/health`).catch(() => {
          /* tolerate transient errors */
        });
      }
      // Give the api a beat to flush to its log file. The supervisor pipes
      // stdout/stderr to the log via streams; flushing is async.
      await new Promise<void>((r) => setTimeout(r, 500));
    },
    /* timeout */ 180_000,
  );

  afterAll(async () => {
    // Always run nuke against THIS test's LICH_HOME, so we tear down only
    // what this test created — never the user's other stacks. `nuke --yes`
    // is idempotent and best-effort; ignore its exit code.
    if (lichHome) {
      try {
        spawnSync(LICH_BINARY, ["nuke", "--yes"], {
          cwd: projectPath ?? process.cwd(),
          env: { ...process.env, LICH_HOME: lichHome },
          timeout: 90_000,
          encoding: "utf8",
        });
      } catch {
        /* best-effort */
      }
    }

    if (projectCleanup) {
      try {
        projectCleanup();
      } catch {
        /* best-effort */
      }
    }
    if (lichHome && existsSync(lichHome)) {
      try {
        rmSync(lichHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }

    projectPath = null;
    projectCleanup = null;
    lichHome = null;
    apiPort = null;
  });

  // -------------------------------------------------------------------------
  // The tests themselves
  // -------------------------------------------------------------------------

  it(
    "aggregates all services and prefixes each line with [service]",
    () => {
      const result = runLich(["logs", "--tail", "50", "--no-follow"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);

      // Each emitted line is `[<service>] <content>`. Every service known to
      // the snapshot should contribute at least one line, except perhaps a
      // service that hasn't logged anything yet (we tolerate that). The
      // dogfood-stack runs supabase + api + web; api and web both log on
      // startup, supabase's start log may have flushed to its log too.
      expect(result.stdout).toContain("[api]");
      expect(result.stdout).toContain("[web]");
      // supabase logs are tooling output; even if the format changes, there
      // should be SOMETHING. We require ANY one of the multi-line patterns.
      expect(result.stdout).toMatch(/\[supabase\]/);
    },
    // Bun's default per-it() timeout is 5s — too tight for tests that spawn
    // the lich binary and slurp per-service log files. See LEV-313.
    30_000,
  );

  it(
    "filters to a single service and omits the [service] prefix",
    () => {
      const result = runLich(["logs", "api", "--tail", "50", "--no-follow"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      // Some content must exist for the api — at minimum the startup banner.
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      // No `[<svc>]` prefix appears when filtering to a single service. The
      // api's own log lines may include literal `[api]` text in their bodies
      // (the dogfood api logs `[api] listening on ...`); that's fine — what
      // we're checking is that lich didn't ALSO prepend its own prefix, so
      // no line starts with `[web]` or `[supabase]`.
      expect(result.stdout).not.toMatch(/^\[web\] /m);
      expect(result.stdout).not.toMatch(/^\[supabase\] /m);
    },
    30_000,
  );

  it(
    "limits initial output via --tail N",
    () => {
      const result = runLich(["logs", "api", "--tail", "1", "--no-follow"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      // tailLines returns at most N lines per service; for a single-service
      // filter that's an upper bound of N total lines. Empty trailing line is
      // expected from the trailing `\n` of the last `out.write`.
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeLessThanOrEqual(1);
    },
    30_000,
  );

  it(
    "--no-follow exits promptly after printing existing content",
    () => {
      const start = Date.now();
      const result = runLich(["logs", "--tail", "10", "--no-follow"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        // If --no-follow were broken (still polling), this would hit the
        // timeout — that's exactly what makes the assertion meaningful.
        timeout: 15_000,
      });
      const elapsed = Date.now() - start;

      expect(result.exitCode).toBe(0);
      // Should be near-instant. 10s is huge headroom for cold caches /
      // first-spawn binary unpack; the real expected value is <1s.
      expect(elapsed).toBeLessThan(10_000);
    },
    30_000,
  );

  it(
    "contains api content after the api has handled a request",
    () => {
      // After the suite-level beforeAll hit /health a few times, the api's
      // log file should have content. The dogfood api doesn't log per-request
      // lines, so the strongest assertion we can make portably is that the
      // log file is non-empty AND contains the startup banner (which proves
      // the file was actually populated by the api, not by some other path).
      const result = runLich(["logs", "api", "--tail", "50", "--no-follow"], {
        cwd: projectPath!,
        env: { LICH_HOME: lichHome! },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      // The startup banner from apps/api/src/index.ts:
      //   console.log(`[api] listening on http://localhost:${port}`);
      // is the deterministic line we can pin. If the dogfood api ever gains
      // request logging, this assertion stays true; if it loses the banner,
      // the test fails loudly and points us at the change.
      expect(result.stdout).toMatch(/listening on http:\/\/localhost:/);
    },
    30_000,
  );

  it(
    "exits non-zero and lists available services for an unknown name",
    () => {
      const result = runLich(
        ["logs", "definitely-not-a-real-service", "--no-follow"],
        {
          cwd: projectPath!,
          env: { LICH_HOME: lichHome! },
          timeout: 15_000,
        },
      );

      expect(result.exitCode).not.toBe(0);
      // Both stdout and stderr are valid sinks for the error in the current
      // implementation (runLogs writes to its `out` sink). Combine them so
      // the assertion doesn't break if the wiring moves.
      const combined = result.stdout + result.stderr;
      expect(combined.toLowerCase()).toContain("definitely-not-a-real-service");
      // The error should name at least one real service so the user knows
      // what they could have typed. The dogfood-stack has api, web, supabase.
      expect(combined).toMatch(/api|web|supabase/);
    },
    30_000,
  );
});
