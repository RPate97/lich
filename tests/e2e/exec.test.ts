/**
 * Plan 2 Task 20 — `lich exec` end-to-end (LEV-340).
 *
 * Drives the real `lich exec` binary against the running dogfood-stack and
 * verifies three observable behaviors that prove the spec's section-5
 * contract for `lich exec`:
 *
 *   1. `lich exec runs an arbitrary command with the stack env`
 *      With the stack up, `lich exec sh -c 'echo $DATABASE_URL'` resolves
 *      the stack env_group and the child sees the interpolated
 *      `postgresql://postgres:postgres@localhost:<digits>/dogfood`. The
 *      digits prove port allocation ran — not just literal pass-through of
 *      `${services.postgres.host_port}`.
 *
 *   2. `--env-group=<X> overrides the default stack group`
 *      `lich exec --env-group=isolated-tools sh -c 'echo $TOOL_MODE-$DATABASE_URL'`
 *      prints `standalone-`: TOOL_MODE from the isolated group, AND empty
 *      DATABASE_URL because isolated-tools has no `extends: stack`. This is
 *      THE proof of isolation — if stack env ever leaks into isolated
 *      groups, this test catches it instantly.
 *
 *   3. `exits 2 with usage when no command argv given`
 *      `lich exec` (no argv) prints `usage: ...` to stderr and exits 2.
 *      Verified without the stack running because it never gets that far.
 *
 * Why the stack must be up for tests 1 + 2:
 *   The dogfood-stack's top-level `env` references
 *   `${services.postgres.host_port}` and `${owned.api.port}`. Those refs
 *   only resolve once allocator state has been written by `lich up`. Test
 *   3 is the only one that doesn't need a live stack — but we still keep
 *   it on the same fixture because the up/down dance dominates suite cost
 *   and amortizing it over three tests is much cheaper than a separate
 *   suite.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME under a tmpdir so the user's real ~/.lich is never touched.
 *   - lich binary built once up front in the (setup) test.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in the (teardown) test to release docker
 *     resources and owned PIDs from the shared fixture.
 *   - tmpdir + LICH_HOME removed after nuke.
 *
 * Hooks live as `it()` blocks (not beforeAll/afterAll) because Bun's hook
 * timeout default is 5s with no per-hook override; pushing setup/teardown
 * into `it()` lets us pass real 3-minute timeouts. Same pattern as
 * tests/e2e/logs.test.ts and tests/e2e/env-groups-isolation.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail loudly (not skip) — the binary is OUR
// code and a broken build is a real bug.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

beforeAll(() => {
  if (existsSync(LICH_BINARY)) return;
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
  if (!existsSync(LICH_BINARY)) {
    throw new Error(
      `lich build reported success but ${LICH_BINARY} does not exist`,
    );
  }
});

// ---------------------------------------------------------------------------
// Shared fixture: one `lich up` amortized across the three tests in this
// suite. Each test asserts a different observable of `lich exec` against the
// same running stack, so one up/down cycle is plenty.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lich exec (Plan 2 Task 20)", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Same prerequisite as basic-up.test.ts (see
      // LEV-313); copyExampleToTmpdir's filter skips node_modules.
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-exec-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      const upResult = runLich(["up"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with exec tests`,
        );
      }
    },
    /* timeout */ 300_000,
  );

  it("runs an arbitrary command with the stack env", () => {
    const fix = fixture!;
    // sh -c form: the cmd is `echo $DATABASE_URL`, but we need the SHELL to
    // expand $DATABASE_URL — bare `echo` (multi-arg) would print the literal
    // string. The `--` separator before `sh` is load-bearing: mri parses
    // the binary's top-level argv and would otherwise eat the `-c` flag as
    // its own option (string value "echo $DATABASE_URL"), leaving the exec
    // command with only `["sh"]` in `_` and producing no output. `--` is
    // the standard CLI convention (`docker exec --`, `kubectl exec --`,
    // `git checkout --`) for "stop parsing my flags, treat the rest as
    // opaque positionals" — Plan 2 Task 19 uses the same pattern when
    // forwarding extras via `lich exec ... -- a b c`.
    const result = runLich(
      ["exec", "--", "sh", "-c", "echo $DATABASE_URL"],
      {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
      },
    );
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // The literal prefix; the trailing `<digits>/dogfood` proves port
    // allocation ran end-to-end (the un-interpolated form would still
    // contain the literal `${services.postgres.host_port}`).
    expect(result.stdout).toMatch(
      /postgresql:\/\/postgres:postgres@localhost:\d+\/dogfood/,
    );
  });

  it("--env-group=<X> overrides the default stack group", () => {
    const fix = fixture!;
    // Same `--` reasoning as the previous test: keeps mri from eating the
    // child's `-c` flag. The `--env-group=isolated-tools` flag MUST appear
    // before `--` so the bin layer sees it; mri ignores flags after `--`.
    const result = runLich(
      [
        "exec",
        "--env-group=isolated-tools",
        "--",
        "sh",
        "-c",
        "echo $TOOL_MODE-$DATABASE_URL",
      ],
      {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
      },
    );
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // `isolated-tools` declares TOOL_MODE=standalone and has NO `extends`,
    // so DATABASE_URL is unset — the shell expands $DATABASE_URL to the
    // empty string. The resulting echo output is `standalone-\n`.
    //
    // This is THE proof of isolation: if a future bug leaks the stack
    // env into a non-extending group, the right-hand side would contain
    // the resolved postgresql URL and this assertion would fail loudly.
    expect(result.stdout.trim()).toBe("standalone-");
  });

  it("exits 2 with usage when no command argv given", () => {
    const fix = fixture!;
    const result = runLich(["exec"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(2);
    // The exec handler emits its usage line on stderr (see
    // packages/lich/src/commands/exec.ts:147). Lowercase the haystack so
    // a future capitalization change ("Usage" vs "usage") doesn't break
    // the assertion.
    expect(result.stderr.toLowerCase()).toContain("usage");
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        // Best-effort nuke; ignore exit code. We're tearing down only the
        // resources THIS test created by scoping LICH_HOME — never another
        // stack the user is running by hand.
        spawnSync(LICH_BINARY, ["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { ...process.env, LICH_HOME: fixture.lichHome },
          timeout: 90_000,
          encoding: "utf8",
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown lich nuke failed:", err);
      }
      try {
        fixture.stackCleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown tmpdir cleanup failed:", err);
      }
      try {
        if (existsSync(fixture.lichHome)) {
          rmSync(fixture.lichHome, { recursive: true, force: true });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    /* timeout */ 180_000,
  );
});
