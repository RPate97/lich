
import { beforeAll, describe, expect, it } from "vitest";
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
  //         resolution interpolates `${services.postgres.host_port}` against
  //         the allocated-ports snapshot and `lich exec` reads back the same
  //         top-level value (no profile threading needed for this case).
  // -----------------------------------------------------------------------
  describe("dev profile (no override): DATABASE_URL = localhost:<allocated-port>", () => {
    let fix: Fixture | null = null;
    let didUp = false;

    it(
      "(setup) brings up the dogfood-stack under the dev profile",
      async () => {
        fix = makeFixture("profiles-env-override-dev");
        const upResult = runLich(["up", "dev"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          // up against the full dogfood stack: postgres pulls fast (~5MB
          // alpine, sub-10s cold) but headroom kept for slow CI boxes.
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
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
        });
        expect(urlsResult.exitCode).toBe(0);
        const urls = parseLichUrls(urlsResult.stdout);
        const apiUrl = urls.api;
        expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
        await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
        await expectDbMode(apiUrl!, "live");
      },
      300_000,
    );

    it("lich exec resolves DATABASE_URL to localhost with the allocated postgres port", () => {
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
      // Trailing `<digits>/dogfood` proves the
      // `${services.postgres.host_port}` interpolation ran end-to-end — the
      // un-interpolated form would still carry the literal `${...}`
      // reference and this would fail.
      expect(result.stdout).toMatch(
        /postgresql:\/\/postgres:postgres@localhost:\d+\/dogfood/,
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
      180_000,
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
  // overridden DATABASE_URL (`postgresql://postgres:test@db.test.example.com:5432/dogfood`)
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
      async () => {
        fix = makeFixture("profiles-env-override-override");
        const upResult = runLich(["up", "dev:env-override"], {
          cwd: fix.stackPath,
          env: { LICH_HOME: fix.lichHome },
          // Same heavy-up budget as test 1: postgres pulls fast but api
          // will likely fail ready_when because its DB pointer is
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

        // Best-effort /health + expectDbMode("live") — the api server
        // listens on its port regardless of DATABASE_URL reachability
        // (`new SQL(url)` is lazy), so /health should respond. dev:env-override
        // extends dev so DATABASE_URL is non-empty → dbAvailable() is true
        // → /health.db is "live". We swallow probe failures because the
        // primary assertion in the next it() block is what this test
        // actually proves; expectDbMode is a sanity sentinel, not the
        // load-bearing check.
        try {
          const urlsResult = runLich(["urls", "--raw"], {
            cwd: fix.stackPath,
            env: { LICH_HOME: fix.lichHome },
          });
          if (urlsResult.exitCode === 0) {
            const urls = parseLichUrls(urlsResult.stdout);
            const apiUrl = urls.api;
            if (apiUrl) {
              await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 15_000 });
              await expectDbMode(apiUrl, "live");
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `expectDbMode("live") sentinel skipped (api may not be ready under dev:env-override):`,
            err,
          );
        }
      },
      300_000,
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
        "postgresql://postgres:test@db.test.example.com:5432/dogfood",
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
      180_000,
    );
  });
});
