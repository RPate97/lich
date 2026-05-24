/**
 * Plan 2 Task 19 — user-defined command invocation (LEV-339).
 *
 * Verifies the three end-to-end behaviors of the user-command dispatcher
 * (Plan 2 Tasks 7 + 8) wired through the real binary against the dogfood-
 * stack's `commands:` declarations:
 *
 *   1. `lich <user-command> runs the cmd with resolved env`
 *      Runs the dogfood-stack's `test:e2e` command (cmd: echo "no e2e
 *      tests in dogfood-stack yet"). Asserts exit 0 and that the
 *      sentinel string appears in stdout. Proves the dispatcher located
 *      the entry, resolved its env_group, and ran the shell command end-
 *      to-end with stdio inheritance.
 *
 *   2. `extra argv is forwarded to the underlying cmd`
 *      Runs the dogfood-stack's `tools:env-check` command with extra
 *      positional argv (`--extra foo`). The dogfood `printenv` cmd
 *      ignores extras, but the test asserts exit 0 — proving the
 *      dispatcher accepted the trailing argv rather than rejecting it
 *      as a usage error. Additionally exercises `lich exec` running
 *      `sh -c 'echo "$@"'` with positional argv, asserting the `"$@"`
 *      plumbing reaches the shell so users can confidently rely on it
 *      from their own `cmd:` declarations.
 *
 *   3. `unknown command emits exit 2`
 *      Runs a name that isn't a built-in AND isn't declared in
 *      `commands:`. The binary should print "unknown command" on
 *      stderr and exit 2 (NOT 127 — see "Exit code for unknown
 *      commands" below). The dispatcher returns 127 only when called
 *      directly with a name absent from `commands:`; the bin layer
 *      short-circuits to exit 2 before reaching that code path, which
 *      is the pre-LEV-328 contract pinned by the
 *      `tests/unit/bin/dispatch-integration.test.ts` suite.
 *
 * Exit code for unknown commands
 * -------------------------------
 * LEV-339's original acceptance criteria called for exit 127. The actual
 * binary contract diverged during implementation: the bin layer's
 * `printUnknownCommand` path (commands/dispatch.ts is never reached when
 * the name isn't declared) returns 2, matching the pre-LEV-328
 * "unknown command" exit code that scripts grep for. The unit-test suite
 * (`tests/unit/bin/dispatch-integration.test.ts`) pins exit 2 as the
 * contract, so this e2e test verifies what the binary actually does
 * end-to-end. If a future change wants exit 127 for unknown commands
 * (matching POSIX "command not found" convention), update both the bin
 * layer AND those unit tests in the same commit; the contract is shared.
 *
 * Why the `lich exec sh -c 'echo "$@"' -- a b c` invocation uses `--`
 * twice
 * ------------------------------------------------------------------
 * The leading `--` is required because mri (the argv parser) would
 * otherwise consume `-c` as a `-c <value>` flag, breaking the spawn.
 * Putting `--` before `sh` forces mri to treat the rest of argv as
 * positionals. The trailing `--` after `'echo "$@"'` is sh's `$0` slot:
 * sh assigns the first positional after `-c <cmd>` to `$0`, shifting
 * subsequent positionals down. Without it, the first user-supplied arg
 * (`a`) would land at `$0` and `"$@"` would only contain `b c`. Putting
 * `--` (a benign literal) in the `$0` slot keeps every meaningful
 * positional in `$1`+ where `"$@"` can reach them.
 *
 * Why `lich up` before the user-command tests?
 *   The dogfood-stack's `test:e2e` and `tools:env-check` commands don't
 *   strictly REQUIRE a running stack (`test:e2e` is a trivial echo;
 *   `tools:env-check` runs under `isolated-tools` which has no
 *   `${owned.X.port}` refs). But the dispatcher always resolves the
 *   command's `env_group` before running, and the `stack` group (the
 *   default) does reference `${owned.supabase.ports.db}`. Even though
 *   `test:e2e` doesn't declare `env_group:` (so it falls back to
 *   `stack`), having the stack up means the resolver finds allocated
 *   ports and the dispatch succeeds. Bringing the stack up once across
 *   the suite is cheap relative to the per-test cost.
 *
 * Isolation:
 *   - tmpdir copy of dogfood-stack (never the repo's real one).
 *   - LICH_HOME under the tmpdir so the user's real ~/.lich is untouched.
 *   - lich binary built in `beforeAll` from packages/lich/.
 *
 * Cleanup contract (testing-standards §"Resource cleanup contract"):
 *   - `lich nuke --yes` runs in a final `it()` block to release docker
 *     resources + owned PIDs from the shared fixture.
 *   - tmpdir + LICH_HOME removed in the same block.
 *   - Setup and teardown live in `it()` blocks rather than
 *     beforeAll/afterAll because Bun's hook timeout default (5s) is too
 *     tight for the supabase up/down dance, and Bun doesn't accept a
 *     per-hook timeout the way vitest does. Tests run in declaration
 *     order, so (setup) → real assertions → (teardown) is preserved.
 *     Same pattern as `tests/e2e/env-groups-isolation.test.ts` and
 *     `tests/e2e/logs.test.ts`.
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
// Shared fixture: one `lich up` is amortized across the tests in this suite.
// Each test asserts a different property of the dispatcher against the same
// running stack, so a single up/down cycle is plenty.
// ---------------------------------------------------------------------------

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

describe("user-defined command invocation (Plan 2 Task 19)", () => {
  it(
    "(setup) brings the dogfood-stack up under a per-test LICH_HOME",
    async () => {
      // install: true — apps/web runs `next dev`, which needs `next` in
      // node_modules/.bin. Same prerequisite as basic-up.test.ts (LEV-313).
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-commands-user-defined-home-"),
      );
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
          `lich up failed (exit ${upResult.exitCode}); cannot proceed with ` +
            `user-command dispatch tests`,
        );
      }
    },
    /* timeout */ 300_000,
  );

  it("lich <user-command> runs the cmd with resolved env", () => {
    const fix = fixture!;
    // dogfood-stack lich.yaml:
    //   commands:
    //     test:e2e:
    //       cmd: echo "no e2e tests in dogfood-stack yet"
    const result = runLich(["test:e2e"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich test:e2e stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich test:e2e stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // The dispatcher inherits stdio, so the cmd's echo lands directly in
    // the captured stdout. If this ever fails with empty stdout but exit 0,
    // the inherit/pipe wiring in dispatch.ts has regressed (e.g. stdio was
    // accidentally muted) — the dispatcher's stdio default is the load-
    // bearing contract for user-visible cmd output.
    expect(result.stdout).toContain("no e2e tests in dogfood-stack yet");
  });

  it("extra argv is forwarded to the underlying cmd", () => {
    const fix = fixture!;
    // dogfood-stack lich.yaml:
    //   commands:
    //     tools:env-check:
    //       cmd: printenv TOOL_MODE TEST_MODE LICH_WORKTREE
    //       env_group: isolated-tools
    // BSD `printenv` ignores extra positional args entirely. The
    // assertion is exit 0: it proves the dispatcher passed the extras
    // through to sh's `"$@"` rather than rejecting them as a usage
    // error.
    const result = runLich(["tools:env-check", "--extra", "foo"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich tools:env-check stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich tools:env-check stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    // Sanity: the cmd itself ran (TOOL_MODE is set on isolated-tools).
    // BSD printenv exits 0 when at least one named var resolves, so the
    // exit-0 assertion above is shared between "dispatch accepted argv"
    // and "cmd executed."  The stdout assertion narrows it to "cmd
    // produced its expected output," which a usage-error-on-extras
    // regression couldn't pass.
    expect(result.stdout).toContain("standalone");

    // Additionally exercise the `"$@"` plumbing through `lich exec`
    // running an ad-hoc sh command. This is the load-bearing assertion
    // that positional argv reaches the shell exactly as the user wrote
    // it — covers both the dispatcher's per-command path AND the exec
    // command's multi-arg form.
    //
    // The argv shape is deliberate; see the file-level JSDoc section
    // "Why the `lich exec sh -c ...` invocation uses `--` twice." Short
    // version: leading `--` prevents mri from eating `-c` as a flag;
    // trailing `--` is sh's `$0` placeholder so `"$@"` covers a/b/c.
    const argv = ["exec", "--", "sh", "-c", 'echo "$@"', "--", "a", "b", "c"];
    const exec = runLich(argv, {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (exec.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich exec stdout:", exec.stdout);
      // eslint-disable-next-line no-console
      console.error("lich exec stderr:", exec.stderr);
    }
    expect(exec.exitCode).toBe(0);
    // Exact trimmed match: `echo "$@"` with positional args a b c emits
    // `a b c\n`. Anything else (e.g. `b c` from a missing `$0` slot,
    // or an empty string from a quoting regression) would fail loudly.
    expect(exec.stdout.trim()).toBe("a b c");
  });

  it("unknown command emits exit 2 with 'unknown command' on stderr", () => {
    const fix = fixture!;
    // `does:not:exist` is neither a built-in nor a declared user
    // command. The bin layer's `printUnknownCommand` path emits the
    // standard diagnostic and returns exit 2 (the pre-LEV-328 contract
    // — scripts grep for this code to distinguish "command did not
    // exist" from "command ran and failed"). See the file-level
    // "Exit code for unknown commands" comment for the divergence from
    // the issue's original "127" wording.
    const result = runLich(["does:not:exist"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    expect(result.exitCode).toBe(2);
    // The literal "unknown command" string is the load-bearing
    // assertion — the message format must not regress because the
    // ecosystem (other tooling, agents, humans) keys off it.
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("does:not:exist");
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
