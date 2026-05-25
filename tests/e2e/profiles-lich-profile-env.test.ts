/**
 * Plan 3 Task 21 (LEV-395) — `LICH_PROFILE` env var threads into the
 * resolved stack env so spawned services / `lich exec` / `lich env stack`
 * consumers can see which profile their stack is running under.
 *
 * Three observable contracts pinned end-to-end through the real binary:
 *
 *   1. `LICH_PROFILE is visible via lich exec when a profile is active`
 *      `lich up dev:env-override` against a minimal synthetic yaml, then
 *      `lich exec sh -c 'echo $LICH_PROFILE'` prints `dev:env-override`.
 *      This is the practical sentinel for the env pipeline: if the stack
 *      adapter (`groups/built-in-stack.ts`) ever stops forwarding the
 *      profile to `resolveTopLevelEnv`, OR if `commands/exec.ts` stops
 *      reading `state.json`'s `active_profile`, this test fires.
 *
 *   2. `LICH_PROFILE in the env_group stack output reflects the active profile`
 *      With the SAME fixture up under `dev:env-override`, `lich env stack`
 *      emits a `LICH_PROFILE=dev:env-override` line. The dotenv serializer
 *      (`commands/env.ts`'s `serializeDotenv`) sorts keys alphabetically and
 *      quotes only values whose contents would round-trip-fail, so the
 *      literal line we assert on is stable across runs. This pins the same
 *      chain as test 1 but through the `lich env <group>` surface.
 *
 *   3. `LICH_PROFILE is absent when no profile is active`
 *      A separate synthetic minimal yaml with NO `profiles:` section, no
 *      stack up (so `state.json` doesn't exist and the active_profile fall-
 *      through can't possibly mis-fire). `lich env stack` MUST NOT emit
 *      any `LICH_PROFILE=` line — the auto-inject is gated on `profileName`
 *      being supplied (see env/resolve.ts `autoInjects`). This pins the
 *      "absent when no profile" semantics the spec calls out so a future
 *      implementation that always injects an empty `LICH_PROFILE=""` would
 *      fail loudly here.
 *
 * Why a synthetic yaml instead of dogfood-stack:
 *   The Linear task spec recommends "dogfood for the with-profile case
 *   since dogfood has both profiles defined." In practice the dogfood
 *   stack's `dev` profile depends on `supabase migration up` succeeding in
 *   `after_up`, which is environment-flaky (port conflicts with other
 *   stacks the user may be running), and its `dev:env-override` profile
 *   overrides `DATABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` to non-resolving
 *   hostnames such that the web service's `ready_when: http_get: /` fails
 *   (the React page errors out fetching API data the unreachable DB can't
 *   serve). Neither failure mode is relevant to the LICH_PROFILE wiring —
 *   they're orthogonal dogfood-stack quirks.
 *
 *   The contract under test is purely "the active profile name surfaces
 *   in the stack env." A 12-line synthetic yaml with a single sleep-based
 *   owned service exercises the same code path (resolveProfile →
 *   resolveEnvGroup → resolveTopLevelEnv → autoInjects → LICH_PROFILE
 *   injection → exec/env consumes the snapshot's `active_profile`) WITHOUT
 *   depending on supabase, docker, the dogfood DB schema, the dogfood web
 *   service, or any first-pull image latency. The test runs in seconds,
 *   not minutes, and is hermetic against the user's parallel work.
 *
 *   When dogfood-stack's `dev:env-override` becomes self-consistent (see
 *   Plan 3 Task 18's deferred follow-up about per-profile depends_on
 *   overrides), this test could be retargeted at the dogfood without
 *   changing the contract. The synthetic-yaml approach is the minimum-
 *   viable shape that proves the wiring works end-to-end today.
 *
 * Why two profiles defined (`dev`, `dev:env-override`) in the synthetic
 * yaml even though we only `lich up dev:env-override`:
 *   Multiple profiles forces the resolver to pick the requested one rather
 *   than collapsing to a single-profile passthrough. If a future bug
 *   resolved to the first-listed profile regardless of the positional arg,
 *   the LICH_PROFILE-equals-requested-name assertion catches it. Same
 *   shape as the dogfood-stack's profiles section so the test is
 *   structurally representative.
 *
 * Isolation:
 *   - Per-test tmpdir for the yaml + LICH_HOME so the user's real
 *     ~/.lich is never touched and concurrent runs don't collide.
 *   - Owned service uses `sleep 99999` so it doesn't spawn docker, doesn't
 *     bind any user-visible ports beyond the allocator-assigned one, and
 *     can be torn down by a SIGTERM from `lich down` / `lich nuke`.
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` in the (teardown) `it()` block kills the sleeping
 *     owned-service process and removes per-LICH_HOME state.
 *   - tmpdir + LICH_HOME removed in the same teardown block.
 *   - Test 3 has no stack to tear down (we never brought one up); inline
 *     try/finally cleans up its tmpdirs even on assertion failure.
 *   - All cleanup is best-effort: swallow errors so a cleanup failure
 *     doesn't mask the real assertion failure (it would leak resources,
 *     hence the `console.warn` so CI surfaces the leak).
 *
 * Hooks live as `it()` blocks (not beforeAll/afterAll) because Bun's hook
 * timeout default is 5s with no per-hook override; pushing setup/teardown
 * into `it()` lets us pass real per-step timeouts. Same pattern as
 * tests/e2e/exec.test.ts, tests/e2e/env-groups-isolation.test.ts,
 * tests/e2e/logs.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "./helpers/lich.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail loudly (not skip) — the binary is OUR
// code, and a broken build is a real bug to surface.
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
// Synthetic yaml fixture: minimal stack that exists ONLY to exercise the
// LICH_PROFILE wiring. One owned service that just sleeps (no real workload)
// so the up completes in seconds without any docker / supabase dependency.
// Two profiles so the resolver has to pick the requested one, mirroring the
// dogfood-stack's profile shape without inheriting its environmental flakes.
// ---------------------------------------------------------------------------

/**
 * Build the minimal lich.yaml content used by tests 1 + 2. The `idle` owned
 * service sleeps forever with a `ready_when.log_match` that matches the
 * single line it emits — `lich up` returns successfully within ~1 second,
 * and the service stays alive for `lich exec` / `lich env` to query the
 * resolved env against the on-disk state.json.
 *
 * Two profiles (`dev` as default, `dev:env-override` as the non-default
 * named) so the test's `lich up dev:env-override` actively selects the
 * non-default — proving the chain handles arbitrary profile names, not
 * just the default fall-through.
 */
function syntheticYamlWithProfiles(): string {
  return [
    'version: "1"',
    "",
    "owned:",
    "  idle:",
    // echo "ready" satisfies ready_when.log_match below; sleep keeps the
    // process alive so the stack stays in `status: up` for the lich exec /
    // lich env queries that follow. 99999 is the conventional "effectively
    // infinite" in lich's e2e tests (used by dogfood-stack's tunnel_demo).
    "    cmd: 'sh -c \"echo ready; sleep 99999\"'",
    "    ready_when:",
    "      log_match: 'ready'",
    // Generous timeout so a slow CI runner's `sh` startup doesn't make this
    // test flake. 10s is well within "no human is waiting" but >>10x the
    // expected ~0.1s.
    "      timeout: 10s",
    "",
    "profiles:",
    "  dev:",
    "    default: true",
    "    owned: [idle]",
    "  dev:env-override:",
    "    extends: dev",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Shared fixture for tests 1 + 2: one `lich up dev:env-override` amortized
// across both LICH_PROFILE assertions. Each test reads a different surface
// (`lich exec` for test 1, `lich env stack` for test 2) against the same
// running stack, so a single up/down cycle is plenty.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  lichHome: string;
}

let fixture: Fixture | null = null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LICH_PROFILE threads into stack env when a profile is active (Plan 3 Task 21)", () => {
  it(
    "(setup) brings a synthetic stack up under the dev:env-override profile",
    () => {
      const stackPath = mkdtempSync(
        join(tmpdir(), "lich-e2e-profiles-lich-profile-env-stack-"),
      );
      const lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-profiles-lich-profile-env-home-"),
      );
      writeFileSync(
        join(stackPath, "lich.yaml"),
        syntheticYamlWithProfiles(),
        "utf8",
      );
      fixture = { stackPath, lichHome };

      // Explicit `dev:env-override` (non-default) — proves the chain handles
      // arbitrary profile names selected via the positional arg, not just
      // the default-picker fall-through. If a future bug always picked the
      // default regardless of argv, this test catches it because the next
      // `it()` asserts LICH_PROFILE equals "dev:env-override", not "dev".
      const upResult = runLich(["up", "dev:env-override"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up dev:env-override stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up dev:env-override stderr:", upResult.stderr);
        throw new Error(
          `lich up dev:env-override failed (exit ${upResult.exitCode}); cannot proceed with LICH_PROFILE tests`,
        );
      }
    },
    /* timeout */ 60_000,
  );

  it("lich exec sees LICH_PROFILE equal to the active profile name", () => {
    const fix = fixture!;
    // The `--` separator before `sh` is load-bearing: mri parses the
    // binary's top-level argv and would otherwise eat the `-c` flag as its
    // own option (string value "echo $LICH_PROFILE"), leaving the exec
    // command with only `["sh"]` in `_` and producing no output. `--` is
    // the standard CLI convention (`docker exec --`, `kubectl exec --`,
    // `git checkout --`) for "stop parsing my flags, treat the rest as
    // opaque positionals". Same reasoning as tests/e2e/exec.test.ts.
    const result = runLich(
      ["exec", "--", "sh", "-c", "echo $LICH_PROFILE"],
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
    // stdout will end in a newline from the echo; trim before compare so a
    // trailing whitespace/newline change wouldn't break the assertion.
    expect(result.stdout.trim()).toBe("dev:env-override");
  });

  it("lich env stack emits LICH_PROFILE=<active profile> on a stable dotenv line", () => {
    const fix = fixture!;
    const result = runLich(["env", "stack"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich env stack stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich env stack stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    // The dotenv serializer (commands/env.ts::serializeDotenv) sorts keys
    // alphabetically and quotes only values the parser would mis-read.
    // `dev:env-override` contains a `:` which is in the BARE_SAFE_RE
    // whitelist (URL/path-friendly chars), so it's emitted unquoted as
    // `LICH_PROFILE=dev:env-override`. If a future change tightens the
    // whitelist to exclude `:`, this regex catches the quoting drift.
    expect(result.stdout).toMatch(/^LICH_PROFILE=dev:env-override$/m);
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        // Best-effort nuke; ignore exit code. We're tearing down only the
        // owned `idle` process we spawned — never another stack the user is
        // running by hand (LICH_HOME is per-test). `nuke` over `down` is
        // fine here because the suite owns the LICH_HOME exclusively.
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 30_000,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown lich nuke failed:", err);
      }
      try {
        rmSync(fixture.stackPath, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown stack tmpdir cleanup failed:", err);
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
    /* timeout */ 60_000,
  );
});

describe("LICH_PROFILE is absent when no profile is active (Plan 3 Task 21)", () => {
  it("a yaml with no profiles section produces stack env without LICH_PROFILE", () => {
    // Synthetic minimal yaml — no `profiles:` section, no owned/services.
    // The env_group `stack` resolution path still produces a useful env map
    // (process.env + auto-injects + top-level env literals) and the auto-
    // inject for LICH_PROFILE is gated on `profileName` being supplied
    // (see env/resolve.ts::autoInjects). Without a profile, the field MUST
    // be absent — not present-but-empty.
    //
    // No `lich up` happens here: state.json doesn't exist, so even the
    // exec/env active_profile-from-snapshot fallthrough (LEV-395 wiring)
    // can't possibly inject the var. This is the "negative space" test
    // that proves the gating works.
    const dir = mkdtempSync(
      join(tmpdir(), "lich-e2e-profiles-lich-profile-env-noprofile-"),
    );
    const home = mkdtempSync(
      join(
        tmpdir(),
        "lich-e2e-profiles-lich-profile-env-noprofile-home-",
      ),
    );

    try {
      // Truly minimal: just the schema version line. No services, no env,
      // no profiles. `lich env stack` should produce process.env + auto-
      // injects (LICH_WORKTREE, LICH_STACK_ID) and nothing else from lich.
      const yaml = ['version: "1"', ""].join("\n");
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["env", "stack"], {
        cwd: dir,
        env: { LICH_HOME: home },
      });
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich env stack stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("lich env stack stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);

      // Negative assertion: no `LICH_PROFILE=` line on any output line.
      // Multiline anchor (`m` flag) so a stray `LICH_PROFILE=foo` mid-
      // output would still fire. Pattern matches the dotenv key prefix so
      // an unrelated value containing "LICH_PROFILE" as a substring doesn't
      // produce a false positive.
      expect(result.stdout).not.toMatch(/^LICH_PROFILE=/m);

      // Sanity: the env group did resolve (it's not just an empty output
      // that would also pass the negative check). LICH_WORKTREE is always
      // auto-injected for every stack — its presence confirms the pipeline
      // ran through to the auto-inject step. If this regresses, the test
      // would catch a worktree-injection bug AS WELL as the LICH_PROFILE
      // one rather than silently degrading.
      expect(result.stdout).toMatch(/^LICH_WORKTREE=/m);
    } finally {
      // Inline cleanup — this test creates no stacks/containers; the only
      // residue is two tmpdirs. Wrap each in try/catch so an assertion
      // failure that threw mid-flight doesn't leak.
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
  });
});
