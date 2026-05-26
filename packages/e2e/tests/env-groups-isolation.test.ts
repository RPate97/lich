/**
 * Plan 2 Task 22 — `env_groups` isolation and `process_env` (LEV-342).
 *
 * Verifies the three end-to-end env_group resolution semantics that prove
 * spec section 4's patterns A, B, C work through the real binary:
 *
 *   1. `process_env: false blocks shell env passthrough`
 *      Set a shell env var via the runLich `env` override, then run
 *      `lich env isolated-tools`. The output must NOT contain the leaked
 *      var — isolated-tools declares `process_env: false`.
 *
 *   2. `extends: stack inherits stack env`
 *      Run `lich env stack-plus-test`. The output must contain BOTH the
 *      stack-derived `DATABASE_URL=postgresql://...` AND the literal
 *      `TEST_MODE=integration` declared on the group itself.
 *
 *   3. `user group without extends does NOT include stack env`
 *      Run `lich env isolated-tools`. The output must NOT contain
 *      `DATABASE_URL`, even though that's on the resolved `stack` group —
 *      isolated-tools has no `extends`.
 *
 * Together these pin the env_groups isolation guarantees end-to-end.
 *
 * Why `lich up` before `lich env`?
 *   The dogfood-stack's `stack` env references
 *   `${services.postgres.host_port}` etc. — those refs only resolve after
 *   the postgres service has been allocated a host port (which happens
 *   during `lich up`). For test 2 (`extends: stack`) and test 3 (`without
 *   extends`) the stack must be up so port allocation has written
 *   `state.json`. Test 1 (`process_env` isolation) doesn't strictly need a
 *   live stack — `isolated-tools` has no interpolation refs — but we keep
 *   all three tests on the same fixture so the up/down cost is paid once
 *   across the suite.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME under the tmpdir so the user's real ~/.lich is untouched.
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in `afterAll` to release docker resources +
 *     owned PIDs from the shared fixture.
 *   - tmpdir + LICH_HOME removed in `afterAll`.
 */

import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { parseLichUrls } from "../helpers/urls.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// ---------------------------------------------------------------------------
// Build the binary up front. We fail loudly (don't skip) — the binary is OUR
// code, and a broken build is a real bug.
// ---------------------------------------------------------------------------


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
// Shared fixture: one `lich up` is amortized across the three tests in this
// suite. Each test asserts a different isolation property against the same
// running stack, so a single up/down cycle is plenty.
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
//
// Setup and teardown live in `it()` blocks rather than beforeAll/afterAll
// because Bun's hook timeout default (5s) is too tight for the up/down
// dance, and Bun doesn't accept a per-hook timeout argument the way vitest
// does. Putting them in `it()` blocks lets us pass a real timeout per
// step. Tests run in declaration order, so (setup) → real assertions →
// (teardown) is preserved. Same pattern as tests/e2e/logs.test.ts.

describe("env_groups isolation (Plan 2 Task 22)", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Same prerequisite as basic-up.test.ts (see LEV-313).
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-groups-iso-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // Explicit "dev" profile arg: the e2e suite's default flipped to
      // dev:fast (no postgres). Test 2 asserts on DATABASE_URL with the
      // allocated postgres host port — only present under the dev profile.
      // Lives in the compose pool — see tests/e2e/_pool-manifest.ts.
      const upResult = runLich(["up", "dev"], {
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
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with env_group tests`,
        );
      }

      // Probe /health and verify db: "live" — catches accidental profile
      // drift loudly at setup time. If the dispatcher ever lost the "dev"
      // arg above (default flip, env leak), this fails with a clear
      // message instead of silently passing with stub data.
      //
      // `urls --raw` returns the localhost upstream (http://127.0.0.1:<port>)
      // rather than the friendly URL via the daemon proxy. The friendly URL
      // routing can race the proxy's bind / route-table refresh after up;
      // raw probes the api server directly and avoids that race.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
      await expectDbMode(apiUrl!, "live");
    },
    /* timeout */ 300_000,
  );

  it("process_env: false blocks shell env passthrough", () => {
    const fix = fixture!;
    const result = runLich(["env", "isolated-tools"], {
      cwd: fix.stackPath,
      // The runLich helper merges these on top of process.env when invoking
      // the child. LEAK_TEST is the canary: it MUST NOT appear in the
      // resolved `isolated-tools` group (process_env: false).
      env: { LICH_HOME: fix.lichHome, LEAK_TEST: "from-shell" },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // The literal LEAK_TEST key (and its from-shell value) must be absent.
    // Use exact-key match rather than a loose substring to avoid false
    // negatives from any unrelated text that happens to contain the
    // substring (the literal isn't in any baseline group's keys).
    expect(result.stdout).not.toMatch(/^LEAK_TEST=/m);
    expect(result.stdout).not.toContain("from-shell");
    // Sanity: the group's own literal IS present.
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
  });

  it("extends: stack inherits stack env", () => {
    const fix = fixture!;
    const result = runLich(["env", "stack-plus-test"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // From the inherited `stack` group: DATABASE_URL gets interpolated with
    // the allocated postgres port (digits prove port resolution ran end-to-
    // end, not just literal-pass-through).
    expect(result.stdout).toMatch(
      /^DATABASE_URL=postgresql:\/\/postgres:postgres@localhost:\d+\/dogfood$/m,
    );
    // From the group's own `env:` literal.
    expect(result.stdout).toMatch(/^TEST_MODE=integration$/m);
  });

  it("user group without extends does NOT include stack env", () => {
    const fix = fixture!;
    const result = runLich(["env", "isolated-tools"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // The stack-defined var must NOT appear: isolated-tools has no
    // `extends`, so the stack pipeline doesn't run for this group.
    expect(result.stdout).not.toMatch(/^DATABASE_URL=/m);
    // Sanity: the group's own literal IS present, confirming we got real
    // output (not an empty file that would also pass the negative checks).
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 120_000,
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
        rmSync(fixture.lichHome, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    /* timeout */ 180_000,
  );
});
