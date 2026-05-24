/**
 * E2e — `lich env <group>` dotenv output (Plan 2 Task 21 / LEV-341).
 *
 * Verifies the four end-to-end behaviors of `lich env <group>`:
 *
 *   1. `lich env stack prints dotenv with allocated-port values`
 *      Running `lich env stack` after `lich up` prints the resolved stack
 *      env as dotenv. The dogfood-stack's `DATABASE_URL` is interpolated
 *      with the actual allocated postgres port (digits, not the literal
 *      `${owned.supabase.ports.db}` token). The auto-injected
 *      `LICH_WORKTREE` and `LICH_STACK_ID` also appear, proving the
 *      built-in stack adapter produced a complete map.
 *
 *   2. `lich env output is sourceable in bash`
 *      The load-bearing assertion for the dotenv quoting/escaping rules
 *      (Task 11). Write `lich env stack` output to a tmpfile, spawn a real
 *      bash subprocess that sources it, and verify `$DATABASE_URL` round-
 *      trips intact. Bash is the truth function for "is this dotenv well-
 *      formed?" — if quoting drops the `:` or `/` in `postgresql://...`,
 *      the source step would error or produce a corrupted value.
 *
 *   3. `lich env <isolated-group> does not include stack vars`
 *      Running `lich env isolated-tools` produces ONLY the group's own
 *      literals — `TOOL_MODE=standalone` is present, but `DATABASE_URL`
 *      and `LICH_STACK_ID` are absent (the isolated-tools group has no
 *      `extends`, so the stack pipeline doesn't run). This pins the
 *      isolation guarantee for the dotenv output path specifically.
 *
 *   4. `lich env <unknown> exits 1`
 *      Asking for a group that doesn't exist returns a non-zero exit code
 *      with a useful error message.
 *
 * Together these pin the user-facing contract for `lich env`.
 *
 * Why `lich up` before `lich env`?
 *   The dogfood-stack's `stack` env references `${owned.supabase.ports.db}`
 *   etc. — those refs only resolve after the supabase service has been
 *   allocated ports (which happens during `lich up`). Tests 1, 2, and 3
 *   all benefit from a live stack, so we amortize one up/down across all
 *   four tests. Test 4 doesn't strictly need the stack but runs on the
 *   shared fixture for consistency.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME under the tmpdir so the user's real ~/.lich is untouched.
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in the (teardown) `it()` block to release
 *     docker resources + owned PIDs from the shared fixture.
 *   - tmpdir + LICH_HOME removed in the (teardown) `it()` block.
 *
 * Setup/teardown live in `it()` blocks rather than beforeAll/afterAll
 * because Bun's hook timeout default (5s) is too tight for the supabase
 * up/down dance, and Bun doesn't accept a per-hook timeout argument the
 * way vitest does. Putting them in `it()` blocks lets us pass a real
 * timeout per step. Tests run in declaration order. Same pattern as
 * tests/e2e/env-groups-isolation.test.ts and tests/e2e/logs.test.ts.
 */

import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. We fail loudly (don't skip) — the binary is OUR
// code, and a broken build is a real bug.
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dir, "../..");
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
// Shared fixture: one `lich up` is amortized across the four tests in this
// suite. Each test asserts a different aspect of `lich env <group>` against
// the same running stack, so a single up/down cycle is plenty.
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

describe("lich env <group> (Plan 2 Task 21)", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Same prerequisite as basic-up.test.ts (see LEV-313).
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-dotenv-home-"));
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
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with env tests`,
        );
      }
    },
    /* timeout */ 300_000,
  );

  it("lich env stack prints dotenv with allocated-port values", () => {
    const fix = fixture!;
    const result = runLich(["env", "stack"], {
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
    // DATABASE_URL must contain the actual allocated postgres port (digits),
    // not the literal `${owned.supabase.ports.db}` token. Digits between `:`
    // and `/postgres` prove the interpolation flowed through end-to-end with
    // allocated ports populated.
    expect(result.stdout).toMatch(
      /^DATABASE_URL=postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/postgres$/m,
    );
    // The built-in stack adapter auto-injects these — verify both made it
    // into the dotenv output.
    expect(result.stdout).toMatch(/^LICH_WORKTREE=/m);
    expect(result.stdout).toMatch(/^LICH_STACK_ID=/m);
  });

  it("lich env output is sourceable in bash", () => {
    const fix = fixture!;

    // 1. Capture `lich env stack` output to a tmpfile.
    const envResult = runLich(["env", "stack"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(envResult.exitCode).toBe(0);

    const envFile = join(fix.lichHome, "stack.env");
    writeFileSync(envFile, envResult.stdout);

    // 2. Source the file in a real bash subprocess and echo $DATABASE_URL.
    //    Bash is the truth function for "is this dotenv well-formed?" —
    //    if our quoting drops the `:` or `/` in `postgresql://...`, the
    //    source step would error or produce a corrupted value.
    //    Using bash directly (rather than shell-escaping the file path
    //    manually) per the implementation note in the task description.
    const bashResult = spawnSync(
      "bash",
      ["-c", `set -a; source ${envFile}; set +a; echo "$DATABASE_URL"`],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (bashResult.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("bash stdout:", bashResult.stdout);
      // eslint-disable-next-line no-console
      console.error("bash stderr:", bashResult.stderr);
      // eslint-disable-next-line no-console
      console.error("env file contents:\n", envResult.stdout);
    }
    expect(bashResult.status).toBe(0);
    // Same allocated-port URL pattern, this time emitted by bash after
    // round-tripping through `source`. Proves dotenv quoting handles `:`,
    // `/`, and `@` correctly.
    expect(bashResult.stdout).toMatch(
      /^postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/postgres$/m,
    );
  });

  it("lich env <isolated-group> does not include stack vars", () => {
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
    // The group's own literal IS present — proves we got real output (not an
    // empty file that would also pass the negative checks below).
    expect(result.stdout).toMatch(/^TOOL_MODE=standalone$/m);
    // Stack-derived keys must NOT appear: isolated-tools has no `extends`,
    // so the stack pipeline doesn't run for this group. Use exact-key match
    // (with `^...=` anchor) so the test fails specifically on accidental
    // inclusion rather than on substring noise.
    expect(result.stdout).not.toMatch(/^DATABASE_URL=/m);
    expect(result.stdout).not.toMatch(/^LICH_STACK_ID=/m);
  });

  it("lich env <unknown> exits 1 with a helpful error", () => {
    const fix = fixture!;
    const result = runLich(["env", "does-not-exist"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(1);
    // The error should mention the unknown name so the user knows what was
    // wrong. Combine stdout+stderr since the implementation can route the
    // error to either sink without breaking the contract.
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("does-not-exist");
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
