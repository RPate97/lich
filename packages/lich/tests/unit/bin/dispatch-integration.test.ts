/**
 * Unit tests for the bin-layer dispatch integration — LEV-328.
 *
 * These tests exercise the routing logic in `bin/lich.ts` that decides:
 *
 *   1. Is `commandName` a built-in? → run the built-in handler.
 *   2. Else, can we load `lich.yaml` AND does it declare
 *      `commands[<name>]`? → fall through to `dispatchUserCommand`,
 *      forward its exit code.
 *   3. Else → emit "unknown command" and exit 2.
 *
 * Test strategy: spawn the actual compiled `lich` binary as a subprocess.
 *
 * Why subprocess rather than module-level unit tests with mocks: `bin/lich.ts`
 * is a CLI entry-point module — its top-level await drives the dispatch
 * decision the moment the module is imported, with no factored-out function
 * we could call from a test. Refactoring the bin layer to expose a testable
 * `runBin(argv)` function would be a separate, larger change. Spawning the
 * binary keeps the test focused on what we care about: argv-in, exit-code +
 * stderr-out, with the real routing logic in the middle. This is the same
 * pattern `sigint.test.ts` uses for the bin-layer SIGINT handler.
 *
 * Each test runs in <1s — the user commands invoked are trivial shell
 * (`echo`, `printenv`, `exit N`) so the suite stays fast even running serially.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const packageRoot = resolve(__dirname, "../../..");
const lichBinary = resolve(packageRoot, "dist/lich");

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  // Build the binary if it isn't present. Mirrors the pattern in
  // sigint.test.ts — the dist artifact is built once and reused across the
  // whole bin-layer test suite; we only rebuild when it's actually missing.
  if (!existsSync(lichBinary)) {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(
        `failed to build lich binary: ${build.stderr || build.stdout}`,
      );
    }
  }
  if (!existsSync(lichBinary)) {
    throw new Error(`lich binary still missing at ${lichBinary}`);
  }
});

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-dispatch-home-"));
  // The `stack-` prefix matches the convention in other bin tests so
  // `detectWorktree` derives a clean name from the dir basename.
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the lich binary against the test's `projectDir` with the given argv.
 *
 * Each call gets a fresh sub-process — no shared state between invocations.
 * We pass `LICH_HOME` through so the binary writes any state into the
 * test's tmpdir, not the developer's `~/.lich/`.
 *
 * Returns the raw exit status (sync `spawnSync` shape) plus captured
 * stdout/stderr as strings for substring assertions.
 */
function runLich(args: string[]): RunResult {
  const result = spawnSync(lichBinary, args, {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Tests — fall-through to user-command dispatch
// ---------------------------------------------------------------------------

describe("bin/lich.ts — dispatch integration", () => {
  it("falls through to user-command dispatch when name is not a built-in", () => {
    // A trivial user command that succeeds with exit 0 and prints a sentinel.
    // If routing works, we see the sentinel; if dispatch is broken, the
    // binary would have exited 2 with "unknown command" instead.
    writeYaml(`
version: "1"
commands:
  greet:
    cmd: 'echo "hello from user command"'
`);

    const result = runLich(["greet"]);

    // Exit 0 from a successful user command means:
    //   - bin recognized "greet" as NOT a built-in
    //   - bin loaded lich.yaml and found commands.greet
    //   - dispatchUserCommand ran the cmd and returned its exit (0)
    //   - bin forwarded that exit code
    // Each link in that chain is implicitly verified by the success.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello from user command");
  });

  it("forwards the user command's exit code (non-zero)", () => {
    // The dispatcher returns the child's exit code verbatim; the bin layer
    // must NOT translate non-zero into 1. This is the "are we really
    // returning result.exitCode rather than the ok-mapping?" check.
    writeYaml(`
version: "1"
commands:
  fail:
    cmd: 'exit 42'
`);

    const result = runLich(["fail"]);

    expect(result.status).toBe(42);
  });

  it("forwards extra argv to the user command via $@", () => {
    // The dispatcher inserts `--` and a $0 sentinel before extraArgv so the
    // wrapped cmd can reach the forwarded args via "$@". Verify the bin
    // layer threads them through unchanged from argv._.
    writeYaml(`
version: "1"
commands:
  echo-args:
    cmd: 'echo "$@"'
`);

    const result = runLich(["echo-args", "alpha", "beta"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("alpha beta");
  });
});

// ---------------------------------------------------------------------------
// Tests — --env-group=<X> top-level flag
// ---------------------------------------------------------------------------

describe("bin/lich.ts — --env-group override", () => {
  it("parses --env-group=X and forwards to dispatcher", () => {
    // Two groups define MY_VAR differently. With the override flag, the
    // dispatcher should use groupB's value regardless of what the per-command
    // env_group field (groupA) says.
    writeYaml(`
version: "1"
env_groups:
  groupA:
    env:
      MY_VAR: "value-A"
  groupB:
    env:
      MY_VAR: "value-B"
commands:
  show:
    cmd: 'printenv MY_VAR'
    env_group: groupA
`);

    // Without the override, the cmd should see value-A (per-command default).
    const baseline = runLich(["show"]);
    expect(baseline.status).toBe(0);
    expect(baseline.stdout.trim()).toBe("value-A");

    // With `--env-group=groupB`, the cmd should see value-B — proving the
    // bin layer extracted the flag from argv and threaded it into dispatch
    // as `envGroupOverride`.
    const overridden = runLich(["show", "--env-group=groupB"]);
    expect(overridden.status).toBe(0);
    expect(overridden.stdout.trim()).toBe("value-B");
  });

  it("accepts the space-separated form (--env-group X)", () => {
    // mri's `string: ["env-group"]` declaration also handles the
    // `--env-group X` form (separate argv entries). This pins that
    // behavior so we don't regress to consuming X as a positional.
    writeYaml(`
version: "1"
env_groups:
  custom:
    env:
      MY_VAR: "spaced-form-value"
commands:
  show:
    cmd: 'printenv MY_VAR'
`);

    const result = runLich(["show", "--env-group", "custom"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("spaced-form-value");
  });
});

// ---------------------------------------------------------------------------
// Tests — unknown command
// ---------------------------------------------------------------------------

describe("bin/lich.ts — unknown command handling", () => {
  it("prints 'unknown command' when neither built-in nor user command", () => {
    // Valid config, but the requested name isn't declared. The binary
    // should print the standard diagnostic and exit 2 (the pre-LEV-328
    // contract — scripts that check for "command didn't exist at all"
    // depend on this code).
    writeYaml(`
version: "1"
commands:
  greet:
    cmd: 'echo hi'
`);

    const result = runLich(["totally-not-a-command"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("totally-not-a-command");
    // The hint points at the discovery surface — same convention the
    // bin layer's pre-LEV-328 "unknown command" message used.
    expect(result.stderr.toLowerCase()).toContain("lich help");
  });

  it("prints 'unknown command' when no lich.yaml is present", () => {
    // No yaml at all → user commands can't be declared anywhere → unknown.
    // (Don't writeYaml.) This is the common case for "user ran lich from
    // a directory that isn't a worktree" and should fail clearly rather
    // than crash on the yaml load.
    const result = runLich(["random-name"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("random-name");
  });

  it("returns 2 when config parse fails (yaml syntax error)", () => {
    // Malformed yaml means we can't see whether the name is a declared user
    // command — fail closed with the standard "unknown command" exit.
    // The acceptance criteria pins this: user commands require a valid
    // config, and parse failure must NOT silently succeed or crash.
    writeFileSync(
      join(projectDir, "lich.yaml"),
      // Unterminated bracket — yaml parser rejects this.
      "version: \"1\"\ncommands: { broken-here\n",
      "utf8",
    );

    const result = runLich(["whatever"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("returns 2 when commands: section is absent entirely", () => {
    // Config parses, but has no commands: section at all. Same outcome
    // as a malformed config — the name isn't declared, so it's unknown.
    writeYaml(`version: "1"`);

    const result = runLich(["any-name"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });
});

// ---------------------------------------------------------------------------
// Tests — built-in commands keep working
// ---------------------------------------------------------------------------

describe("bin/lich.ts — built-in commands keep working alongside dispatch", () => {
  it("built-in name wins over a user command of the same name (no shadowing path)", () => {
    // Validate the precedence rule: even when a user yaml declares a name
    // that matches a built-in, `isCommand` short-circuits before the
    // dispatch path runs. (Plan-2 validate will refuse such configs at
    // load time, but the runtime contract still has to be: built-in wins.)
    writeYaml(`
version: "1"
commands:
  help:
    cmd: 'echo "user help should never run"'
`);

    const result = runLich(["help"]);

    // We don't care about the exact help output here — only that the user
    // command's `echo` text did NOT appear (proving the built-in ran).
    expect(result.stdout).not.toContain("user help should never run");
  });

  it("--env-group=X is ignored by built-ins that don't read it", () => {
    // Sanity check that the top-level flag declaration doesn't break
    // built-ins which know nothing about env-group. `help` is the
    // simplest IO-free built-in to test against.
    const result = runLich(["help", "--env-group=anything"]);

    // help in an empty-yaml dir lists built-ins; exit should be 0
    // regardless of the env-group flag.
    expect(result.status).toBe(0);
  });
});
