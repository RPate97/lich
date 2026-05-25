/**
 * E2e — lifecycle `env_group` resolution (Plan 2 Task 25 / LEV-345).
 *
 * Sentinel for Plan 2 Task 13's wiring. Task 13 plumbed the
 * `resolveEnvGroup` callback into both `runLifecycle` and
 * `runPerServiceLifecycle` so that long-form lifecycle entries shaped
 * `{ cmd, env_group: <name> }` execute with the resolved group's env
 * instead of the top-level `topLevelEnv`. If Task 13's wiring regresses
 * (e.g. someone drops the callback or hands the executor `undefined`
 * again), this test catches it the next time CI runs.
 *
 * Shape:
 *
 *   1. Copy the dogfood-stack to a tmpdir + chmod the marker script.
 *      (`copyExampleToTmpdir` uses `cpSync`, which preserves the executable
 *      bit, but we re-`chmod +x` defensively so a regression in copy
 *      semantics doesn't masquerade as a wiring bug — bare `cmd: "./..."`
 *      fails with EACCES rather than a useful diagnostic.)
 *   2. Set `LICH_HOME=<tmpdir>` for full isolation from the user's
 *      `~/.lich` and to give the marker script a known write location.
 *   3. `lich up`. The dogfood-stack's new `lifecycle.after_up` long-form
 *      entry runs `./scripts/write-marker.sh` under the
 *      `stack-plus-test` env_group (extends `stack`, adds
 *      `TEST_MODE=integration`).
 *   4. Read `<LICH_HOME>/marker.txt`. Assert it contains:
 *        - `TEST_MODE=integration`              ← layered from the group
 *        - `DATABASE_URL=postgresql://...:N...` ← inherited from `stack`
 *      The second assertion is the load-bearing one: it proves the parent
 *      chain resolved correctly (DATABASE_URL is a `${owned.supabase.ports.db}`
 *      interpolation that ONLY succeeds if the inherited stack env
 *      reached the executor with allocated ports populated).
 *   5. `lich down` + cleanup.
 *
 * Prerequisites: docker + supabase CLI v2+ on PATH. Without them the
 * `lich up` step fails loudly with the real error (see
 * tests/e2e/README.md + LEV-314).
 *
 * Isolation: tmpdir copy + per-test LICH_HOME mean nothing leaks between
 * runs or into the user's real ~/.lich.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Mirror basic-up.test.ts's pattern so this test
// can run in isolation (no implicit dependency on which test ran first).
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
// Per-test fixture state — every test gets a fresh tmpdir / LICH_HOME.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web's `next dev` and apps/api's `bun run dev` need
  // node_modules in the copy (same pattern as basic-up.test.ts).
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  // Defensive chmod — see file-level doc. `cpSync` preserves mode by
  // default, but a future change to the helper (e.g. an explicit-mode option
  // that defaults wrong) shouldn't blow this test up with a confusing
  // EACCES. Idempotent and cheap.
  chmodSync(join(stack.path, "scripts/write-marker.sh"), 0o755);
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-lifecycle-envgrp-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/** Best-effort teardown — logs failures, swallows them. */
function teardownFixture(fix: Fixture): void {
  // LEV-465: timeout tightened from 120s → 20s. afterEach is a fast
  // cleanup path; vitest's hookTimeout caps at 60s anyway, so the old
  // value could never actually fire — it just masked teardown hangs as
  // the wrong error. 20s is generous for a healthy `lich down`.
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lifecycle.after_up env_group resolution (LEV-345 sentinel)", () => {
  it(
    "after_up lifecycle entry uses env_group when specified",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      // Progress logger — writes to stderr so the user sees what phase
      // we're in rather than staring at silence for minutes (mirrors
      // basic-up.test.ts).
      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      // ---- lich up -----------------------------------------------------
      step("lich up (runs after_up hook under stack-plus-test group)");
      const upResult = runLich(["up"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0 — after_up hook completed");

      // ---- assert marker file ------------------------------------------
      const markerPath = join(lichHome, "marker.txt");
      expect(
        existsSync(markerPath),
        `expected marker file at ${markerPath} — after_up hook did not run or wrote to the wrong path`,
      ).toBe(true);

      const marker = readFileSync(markerPath, "utf8");
      step(`marker.txt:\n${marker.replace(/^/gm, "    ")}`);

      // (a) Layered literal from the `stack-plus-test` group. Proves the
      //     env_group resolver ran AT ALL — if Task 13's wiring regressed
      //     to `undefined`, the executor would throw before reaching the
      //     script and `lich up` would have exited non-zero above.
      //     But even with the callback wired, this catches a subtler bug:
      //     if the executor accidentally used the top-level env instead of
      //     the resolved group env, TEST_MODE would be empty (it's only in
      //     the group's literal, not in the top-level `env:` block).
      expect(marker).toContain("TEST_MODE=integration");

      // (b) Inherited interpolated value from the parent `stack` group.
      //     Load-bearing because:
      //       - DATABASE_URL is a top-level env entry whose value is
      //         `postgresql://...:${owned.supabase.ports.db}/postgres`.
      //         Interpolation only resolves if the supabase service's
      //         ports map is populated — which it only is when the parent
      //         chain reached `resolveStackGroup` with the allocated-ports
      //         context. A bug that resolved the group with an empty
      //         allocated-ports context would still produce a value, but
      //         the interpolation would throw before write.
      //       - The presence of digits between `:` and `/postgres` proves
      //         port allocation flowed through correctly. A literal-string
      //         leak (e.g. the un-interpolated `${...}` token) would fail
      //         the digit-class assertion.
      expect(marker).toMatch(
        /DATABASE_URL=postgresql:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/postgres/,
      );

      // ---- lich down: in-test teardown ---------------------------------
      // Doing the bulk of teardown here (rather than leaving everything to
      // afterEach) keeps the `afterEach` hook fast — Bun enforces a 5s
      // default timeout on hooks with no per-hook override, and `lich down`
      // on the dogfood-stack (supabase stop + container teardown) routinely
      // takes 20-30s. afterEach still issues a second best-effort `lich
      // down` so that a test body throw doesn't leak containers, but that
      // second call is idempotent + fast against an already-stopped stack.
      step("lich down (teardown)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");
    },
    // 5-minute timeout: bringing up Supabase + API + web is heavy, and the
    // first cold run pulls images. Matches basic-up.test.ts.
    300_000,
  );
});
