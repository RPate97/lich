/**
 * Plan 3 Task 19 (LEV-393) — `lich up` activates the default profile.
 *
 * Two coverage targets pinned by this suite:
 *
 *   1. `lich up (no arg) activates the default profile`
 *      With the dogfood-stack's `dev:fast` profile carrying `default: true`
 *      (post LEV-470's flip, see
 *      docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md),
 *      `lich up` (no positional arg) must bring the stack up under that
 *      profile. We assert this by reading `lich stacks --json` after the
 *      up completes and checking `active_profile === "dev:fast"`. The
 *      field flows: `up.ts` writes it into `state.json`, `stacks.ts`
 *      re-reads the snapshot and surfaces it on the JSON wire. If either
 *      link breaks, the assertion fires — proving the resolver picked the
 *      default, the snapshot wrote it, and the read path serialized it.
 *
 *   2. `lich up exits non-zero with a clear error when no default and no
 *      arg given`
 *      Uses a synthetic minimal yaml (NOT the dogfood-stack) with two
 *      profiles, neither defaulting. `lich up` with no positional must
 *      exit non-zero and the combined output must include "no default
 *      profile" so operators see what to do. The minimal yaml is enough
 *      — no docker involvement at all, the error fires during profile
 *      resolution before any state mutation.
 *
 * Why this test exists separately from `basic-up.test.ts`:
 *   basic-up covers the up→urls→down happy path against the full dogfood
 *   stack but doesn't assert on which profile was activated (Plan 1 had
 *   no profile concept). This file is the Plan 3 specialization: profile
 *   selection works correctly end-to-end through the CLI.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack for test 1; fresh mkdtempSync for test 2.
 *   - LICH_HOME under a per-test tmpdir so the user's real ~/.lich is
 *     untouched and tests don't see each other's state.
 *   - lich binary built in `beforeAll` from packages/lich/ (fail-loud).
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - Test 1 wraps the up phase in a per-test fixture and runs `lich nuke
 *     --yes` in a final `it()` block to release docker + owned PIDs.
 *     Following the env-groups-isolation pattern: setup, asserts, and
 *     teardown each live in `it()` blocks so we can pass a real per-step
 *     timeout (Bun ignores the per-hook timeout argument vitest accepts).
 *   - Test 2 makes no stack — its tmpdir + LICH_HOME removal happens
 *     inline in the test body; the assertion runs before any cleanup
 *     could leak.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyExampleToTmpdir } from "./helpers/tmpdir.js";
import { runLich } from "./helpers/lich.js";
import { waitForHttp200 } from "./helpers/wait.js";
import { expectDbMode } from "./helpers/dbmode.js";
import { parseLichUrls } from "./helpers/urls.js";

// ---------------------------------------------------------------------------
// Build the binary up front. Fail-loud — the binary is OUR code; a broken
// build is a real bug, not something to skip past.
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
// Fixture for the "happy path" test — shared across the (setup) +
// assertion + (teardown) it() blocks. The `lich up` against the dogfood
// stack is amortized across a single block; test 2 (synthetic yaml) runs
// independently and has its own inline tmpdir.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

// ---------------------------------------------------------------------------
// Shape of a single `lich stacks --json` entry — enough fields for what
// this test asserts on. Mirrors `StackRow`'s wire shape in
// packages/lich/src/commands/stacks.ts.
// ---------------------------------------------------------------------------

interface StacksJsonEntry {
  stack_id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services?: Array<{ name: string; state: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Setup and teardown for test 1 live in `it()` blocks (not beforeAll /
// afterAll) because Bun's hook timeout default is 5s and Bun doesn't
// accept a per-hook timeout the way vitest does. Putting them in `it()`
// lets us pass a real per-step timeout. Tests run in declaration order,
// so (setup) → asserts → (teardown) is preserved. Same pattern as
// env-groups-isolation.test.ts and logs.test.ts.

describe("lich up activates the default profile (Plan 3 Task 19)", () => {
  it(
    "(setup) brings the dogfood-stack up with no profile arg",
    async () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Same prerequisite as basic-up.test.ts (LEV-313).
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-default-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      // `lich up` with NO positional argument — this is what we're testing.
      // The dogfood-stack's `dev:fast` profile carries `default: true`, so
      // the resolver should pick it and the stack should come up under
      // "dev:fast" (just api + web, no postgres). --no-browser keeps the
      // test runner from racing a Chrome spawn.
      const upResult = runLich(["up", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        // dev:fast comes up in ~2-3s; 60s is generous headroom for slow CI.
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
        throw new Error(
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with default-profile assertion`,
        );
      }

      // Sanity probe + expectDbMode: catches silent profile drift if the
      // default ever flips back to `dev` (the assertion below on
      // active_profile would also catch it, but expectDbMode fails earlier
      // with a clearer message). Use --raw to sidestep the friendly-URL
      // routing race the fast stack exposes (see basic-up.test.ts header
      // for context).
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
    },
    /* timeout */ 90_000,
  );

  it("lich stacks --json reports active_profile === 'dev:fast'", () => {
    const fix = fixture!;

    const result = runLich(["stacks", "--json"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    // Parse the JSON wire shape. A single up means a single stack entry
    // under this LICH_HOME — there's no cross-test pollution because
    // LICH_HOME is per-test.
    let parsed: StacksJsonEntry[];
    try {
      parsed = JSON.parse(result.stdout) as StacksJsonEntry[];
    } catch (err) {
      throw new Error(
        `lich stacks --json did not return valid JSON.\n` +
          `--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}\n` +
          `--- parse error ---\n${(err as Error).message}`,
      );
    }
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const entry = parsed[0];
    // Sanity: status reflects a successful up. If it doesn't we want a
    // useful error rather than a misleading active_profile assertion
    // failure pointing at the wrong root cause.
    expect(entry.status, `stack status from stacks --json: ${JSON.stringify(entry)}`).toBe("up");

    // The actual contract under test: `default: true` in the dev:fast
    // profile means `lich up` with no arg picks "dev:fast" → the snapshot
    // records active_profile = "dev:fast" → `lich stacks --json` surfaces
    // it on the wire. All three links of the chain are exercised by this
    // single assertion (writing, reading, serializing).
    //
    // Pre LEV-470 the default was "dev" (full DB-backed stack); the e2e
    // suite-solid-and-fast design flipped it to "dev:fast" for speed.
    // The contract under test is unchanged (the chain still preserves
    // whichever name `default: true` selects).
    expect(entry.active_profile).toBe("dev:fast");

    // Service set sanity: dev:fast resolves to just api + web (no
    // postgres, no tunnel_demo). Belt + braces with the active_profile
    // assertion — if the resolver picked the right profile name but
    // somehow brought up the wrong services, this catches it.
    const serviceNames = (entry.services ?? []).map((s) => s.name).sort();
    expect(serviceNames).toEqual(["api", "web"]);
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      // `lich nuke --yes` releases owned PIDs + the daemon in one shot.
      // We prefer nuke over `lich down` here because the suite owns the
      // LICH_HOME exclusively — there's no other stack to preserve.
      // dev:fast has no docker to tear down, so the 20s budget (LEV-465)
      // is plenty.
      try {
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 20_000,
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
    /* timeout */ 60_000,
  );
});

describe("lich up errors when no default profile is set (Plan 3 Task 19)", () => {
  it("exits non-zero with output containing 'no default profile' when no arg given", () => {
    // Synthetic minimal yaml — purely a config-resolution test; no docker,
    // no services to start. The profile-resolver fires in `up.ts` immediately
    // after parsing the config (before worktree detection / port allocation),
    // so the error path never touches the runtime. Using a minimal yaml (no
    // owned/services blocks) keeps the test fast and hermetic.
    const dir = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-no-default-"));
    const home = mkdtempSync(join(tmpdir(), "lich-e2e-profiles-no-default-home-"));

    try {
      // Two profiles, NEITHER with `default: true`. With no positional arg,
      // `lich up` has no default to fall back to and must error out.
      const yaml = [
        'version: "1"',
        "",
        "profiles:",
        "  a: {}",
        "  b: {}",
        "",
      ].join("\n");
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["up"], {
        cwd: dir,
        env: { LICH_HOME: home },
        timeout: 30_000,
      });

      // Exit code MUST be non-zero. Spec section 5 (lich up [profile]):
      // bad-profile / no-default cases exit non-zero with a clear error
      // that lists declared profiles or points at the missing default.
      expect(
        result.exitCode,
        `combined output:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ).not.toBe(0);

      // The error message must mention "no default profile" so operators
      // know what to do. lich's output channel writes structured errors
      // to stdout (the progress stream); stderr is reserved for
      // out-of-band warnings. Check both streams so the assertion is
      // robust to channel-routing changes — the contract is "the
      // user-visible text contains the keyword", not which fd it lands
      // on. Exact wording is pinned by the up.ts unit tests; this e2e
      // only proves the user-facing keyword survives the round trip
      // through the CLI.
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
      expect(combined).toContain("no default profile");
    } finally {
      // Inline cleanup — this test creates no stacks/containers; the only
      // residue is two tmpdirs. Wrap in try/catch each in case the
      // assertion above threw mid-flight.
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
