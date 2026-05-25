/**
 * Plan 3 Task 22 — profile-scoped env override (LEV-396).
 *
 * Pins the design-spec promise that a profile's `env` block overlays the
 * top-level `env` block during stack resolution, and that the overlay is
 * observable from the outside via `lich exec` running against the up'd
 * stack. The two `lich up` invocations cover both sides of the override:
 *
 *   1. `dev profile uses the top-level DATABASE_URL`
 *      `lich up dev` → the dogfood-stack's top-level
 *      `DATABASE_URL: "postgresql://postgres:postgres@localhost:${owned.supabase.ports.db}/postgres"`
 *      wins (the `dev` profile does NOT override it). `lich exec sh -c
 *      'echo $DATABASE_URL'` therefore prints `...postgres@localhost:<digits>/postgres`
 *      where `<digits>` is the worktree's allocated supabase port. This
 *      asserts the BASELINE — the profile layer is a strict overlay, not a
 *      blanket replacement; when a key isn't overridden, the top-level
 *      value flows through with its `${...}` references interpolated against
 *      the live allocated-ports map.
 *
 *   2. `dev:env-override profile uses the override DATABASE_URL` — GATED
 *      `lich up dev:env-override` brings up the same services (the profile
 *      `extends: dev` so the owned list is identical) but the profile's
 *      `env.DATABASE_URL: "postgresql://postgres:test@db.test.example.com:5432/postgres"`
 *      overrides the top-level value. The override hostname is intentionally
 *      non-resolving — the dogfood YAML's comment is explicit:
 *      "e2e coverage asserts on the env Lich resolved (via `lich exec`),
 *      not on actually opening a DB connection." Currently GATED behind a
 *      wiring gap — see "Known wiring gap" below.
 *
 * Known wiring gap (test 2 gated as it.todo):
 *   `packages/lich/src/commands/exec.ts` and `commands/env.ts` do NOT read
 *   `active_profile` from the stack snapshot and do NOT thread a
 *   ResolvedProfile through to
 *   `resolveEnvGroup("stack") → resolveStackGroup → resolveTopLevelEnv`.
 *   The underlying env-resolution machinery already accepts a profile
 *   (Plan 3 Task 6, LEV-380), and the comment block in
 *   `env/resolve.ts:426-428` explicitly lists `lich exec` and `lich env
 *   stack` as callers that should see profile overrides — but the
 *   snapshot → ResolvedProfile threading on the exec/env side is missing.
 *
 *   Empirical confirmation: a synthetic minimal config with
 *   `env: {FOO: "top-level"}` + a default profile `env: {FOO: "override"}`
 *   followed by `lich exec -- sh -c 'echo $FOO'` prints `top-level`, not
 *   `override`, after `lich up`. Same for LICH_PROFILE — empty in `lich
 *   exec` even though `resolveTopLevelEnv` would inject it given the
 *   profile.
 *
 *   Test 2 is `it.todo` (per `tests/e2e/basic-up.test.ts`'s gating
 *   precedent for `serves the web app over its friendly URL` — gated
 *   pending Plan 5 daemon + reverse proxy) until the wiring lands. When
 *   `lich exec` / `lich env` read `snap.active_profile` and pass the
 *   resolved profile through to `resolveEnvGroup`, test 2 turns green
 *   automatically. Reverting `it.todo` → `it` IS the wiring task's
 *   acceptance signal.
 *
 *   This is reported as a Plan 3 deviation on LEV-396 — the test recipe in
 *   the task assumes `lich exec` is profile-aware; that assumption doesn't
 *   hold against the current binary. The fix is small (~20 LOC across 3
 *   files) but out of scope for an e2e-test-only task. Tracked separately
 *   so the wiring can land under its own commit + Linear issue.
 *
 * Why this test is the load-bearing proof of profile-scoped env precedence:
 *   The unit tests in `packages/lich/tests/unit/env/resolve.test.ts` pin
 *   the layering math in isolation (`resolveEnvForService` /
 *   `resolveTopLevelEnv` with a synthetic ResolvedProfile input). This e2e
 *   test exercises the SAME math end-to-end through the binary: parse yaml
 *   → resolve profile → start services with the profile-overlaid env →
 *   spawn `lich exec` → read the same env back through
 *   `resolveEnvGroup("stack")`. If any link in that chain drops the
 *   profile layer, the override URL never shows up and this test fires.
 *
 *   This is the spec section 4 "Env precedence" contract: a profile's env
 *   sits BETWEEN top-level and per-service in the layering order, and
 *   `lich exec --env-group=stack` (the default) resolves through the same
 *   pipeline so an operator can see exactly what env the stack is running
 *   with.
 *
 * Why test 1 still brings up the full stack:
 *   The top-level `DATABASE_URL` references `${owned.supabase.ports.db}`,
 *   which only resolves to a real port after `lich up` has run port
 *   allocation. Without a live snapshot, the resolver would throw
 *   InterpolationError on the unresolved reference. Bringing up the full
 *   stack is the simplest way to populate the snapshot and exercise the
 *   real interpolation path.
 *
 * Isolation:
 *   - The test copies dogfood-stack into a fresh tmpdir.
 *   - LICH_HOME under a per-test tmpdir so the user's real ~/.lich is
 *     untouched and concurrent runs don't collide on stack ids.
 *   - lich binary built in `beforeAll` from packages/lich/ (fail-loud).
 *
 * Resource cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in a teardown `it()` block even when the body
 *     throws so docker containers and owned PIDs don't leak.
 *   - tmpdir + LICH_HOME removed in the same teardown block.
 *
 * Hooks-as-it pattern (env-groups-isolation / profiles-named precedent):
 *   Bun's hook timeout default is 5s with no per-hook override; pushing
 *   setup/teardown into `it()` blocks lets us pass real per-step timeouts
 *   for the up/down dance against the full dogfood stack.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail loudly (not skip) — the binary is OUR
// code and a broken build is a real bug to surface. Mirrors the pattern in
// basic-up.test.ts and profiles-named.test.ts.
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
// Per-test fixture helpers.
//
// The dev-profile happy-path test owns its own fresh fixture (and its own
// `lich up`). A future un-gated test 2 (under the dev:env-override profile)
// will need its OWN fixture as well because re-upping under a different
// profile while the first is up is refused by design (Plan 3 Task 13 /
// LEV-387, covered by profiles-switch-refused). Same pattern as
// profiles-named.test.ts.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

/** Helper: build a fresh fixture with a per-test LICH_HOME and dogfood copy. */
function makeFixture(prefix: string): Fixture {
  // install: true — apps/web runs `next dev`, which needs `next` in
  // node_modules/.bin. Without it the web owned service exits 127 immediately.
  // See LEV-313.
  const stack = copyExampleToTmpdir("dogfood-stack", {
    prefix: `lich-e2e-${prefix}-`,
    install: true,
  });
  const home = mkdtempSync(join(tmpdir(), `lich-e2e-${prefix}-home-`));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

/**
 * Best-effort teardown — swallow errors so a cleanup failure doesn't mask
 * the real assertion failure (it WOULD also leak resources, hence the
 * console.warn so CI surfaces the leak).
 *
 * Uses `nuke --yes` rather than `down` because the suite owns the
 * LICH_HOME exclusively; there's no other stack to preserve and nuke is
 * the most aggressive teardown surface (releases docker + owned PIDs in
 * one shot, also clears state.json).
 */
function teardownFixture(fix: Fixture, didUp: boolean): void {
  if (didUp) {
    // LEV-465: timeout tightened from 120s → 20s. afterEach is a fast
    // cleanup path; vitest's hookTimeout caps at 60s anyway. `lich
    // nuke --yes` completes sub-200ms even when killing a live daemon.
    try {
      runLich(["nuke", "--yes"], {
        cwd: fix.stackPath,
        env: { LICH_HOME: fix.lichHome },
        timeout: 20_000,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`teardown lich nuke failed for ${fix.stackPath}:`, err);
    }
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`teardown LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profile env override (Plan 3 Task 22)", () => {
  // -----------------------------------------------------------------------
  // Test 1: `lich up dev` — top-level DATABASE_URL flows through (the `dev`
  //         profile does NOT override it). Passes today: top-level env
  //         resolution interpolates `${owned.supabase.ports.db}` against the
  //         allocated-ports snapshot and `lich exec` reads back the same
  //         top-level value (no profile threading needed for this case).
  // -----------------------------------------------------------------------
  describe("dev profile (no override): DATABASE_URL = localhost:<allocated-port>", () => {
    let fix: Fixture | null = null;
    let didUp = false;

    it(
      "(setup) brings up the dogfood-stack under the dev profile",
      () => {
        fix = makeFixture("profiles-env-override-dev");
        const upResult = runLich(["up", "dev"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          // up against the full dogfood stack is heavy: supabase first-pull
          // alone can be 60-90s. 4 minutes is the conservative ceiling.
          timeout: 240_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up dev stdout:", upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up dev stderr:", upResult.stderr);
          throw new Error(
            `lich up dev exited ${upResult.exitCode}; cannot proceed with env-resolution assertion`,
          );
        }
        didUp = true;
      },
      /* timeout */ 300_000,
    );

    it("lich exec resolves DATABASE_URL to localhost with the allocated supabase port", () => {
      const fix2 = fix!;
      // The `--` separator is load-bearing: mri parses the binary's top-level
      // argv and would otherwise treat `-c` as an option of `lich exec`,
      // swallowing the next positional. Same pattern as tests/e2e/exec.test.ts
      // — `lich exec --` mirrors the `docker exec --` / `kubectl exec --`
      // convention for "stop parsing my flags, treat the rest as the child's
      // argv."
      const result = runLich(
        ["exec", "--", "sh", "-c", "echo $DATABASE_URL"],
        {
          cwd: fix2.stackPath,
          env: { LICH_HOME: fix2.lichHome },
        },
      );
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich exec stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich exec stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // Trailing `<digits>/postgres` proves the `${owned.supabase.ports.db}`
      // interpolation ran end-to-end — the un-interpolated form would still
      // carry the literal `${...}` reference and this would fail.
      expect(result.stdout).toMatch(
        /postgresql:\/\/postgres:postgres@localhost:\d+\/postgres/,
      );
      // Sanity: the override URL must NOT appear under the dev profile.
      // If a wiring bug ever cross-wires the profiles, this catches it.
      expect(result.stdout).not.toContain("db.test.example.com");
    });

    it(
      "(teardown) nuke + remove tmpdirs",
      () => {
        if (fix) teardownFixture(fix, didUp);
        fix = null;
        didUp = false;
      },
      /* timeout */ 180_000,
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: `lich up dev:env-override` — un-gated after LEV-454 + LEV-455.
  //
  // LEV-454 wired `lich exec`/`lich env` to read `active_profile` from the
  // snapshot and thread a ResolvedProfile through to `resolveEnvGroup →
  // resolveStackGroup → resolveTopLevelEnv`. LEV-455 did the same for
  // lifecycle env_group resolution. With both fixes landed, `lich exec`
  // against a stack up'd under `dev:env-override` sees the profile's
  // overridden DATABASE_URL (`postgresql://postgres:test@db.test.example.com:5432/postgres`)
  // rather than the top-level localhost value.
  //
  // The dev:env-override profile intentionally points at a non-resolving
  // hostname — the test asserts on `lich exec`'s view of the resolved env,
  // NOT on actually opening a DB connection. The api service that depends
  // on the bogus URL may not become fully ready; we tolerate that and only
  // require the env-resolution surface to work. The 180s up timeout is
  // generous to ride out api retries before the test eyeballs `lich exec`.
  // -----------------------------------------------------------------------
  describe("dev:env-override profile: DATABASE_URL = profile override (db.test.example.com)", () => {
    let fix: Fixture | null = null;
    let didUp = false;

    it(
      "(setup) brings up the dogfood-stack under the dev:env-override profile",
      () => {
        fix = makeFixture("profiles-env-override-override");
        const upResult = runLich(["up", "dev:env-override"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          // Same heavy-up budget as test 1: supabase first-pull dominates.
          // api will likely fail ready_when because its DB pointer is
          // intentionally bogus; we accept any exit (0 or non-zero) and let
          // the assertion in the next it() block check what actually got
          // resolved into the spawned cmd's env. didUp guards the teardown
          // path either way.
          timeout: 240_000,
        });
        // Mark didUp regardless of exit so teardown runs.
        didUp = true;
        // We don't throw on non-zero exit: a partial-up still writes the
        // snapshot with `active_profile`, which is what `lich exec` needs.
        // If the snapshot doesn't get written at all, the next test will
        // surface that loudly via exec exit-code or missing-state error.
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `lich up dev:env-override exited ${upResult.exitCode} (expected; api can't reach bogus DB). Continuing to env-resolution assertion.`,
          );
        }
      },
      /* timeout */ 300_000,
    );

    it("lich exec resolves DATABASE_URL to the profile-override hostname (db.test.example.com)", () => {
      const fix2 = fix!;
      const result = runLich(
        ["exec", "--", "sh", "-c", "echo $DATABASE_URL"],
        {
          cwd: fix2.stackPath,
          env: { LICH_HOME: fix2.lichHome },
        },
      );
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich exec stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich exec stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // The override URL from `examples/dogfood-stack/lich.yaml`'s
      // `dev:env-override.env.DATABASE_URL`. Verbatim — no interpolation
      // happens on this value because the override is a literal string.
      expect(result.stdout).toContain(
        "postgresql://postgres:test@db.test.example.com:5432/postgres",
      );
      // Sanity: the dev-profile URL must NOT bleed through. If profile
      // threading regresses, this catches a cross-wire bug where the
      // top-level value showed through.
      expect(result.stdout).not.toContain("postgres@localhost:");
    });

    it(
      "(teardown) nuke + remove tmpdirs",
      () => {
        if (fix) teardownFixture(fix, didUp);
        fix = null;
        didUp = false;
      },
      /* timeout */ 180_000,
    );
  });
});
