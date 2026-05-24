/**
 * Unit tests for the user-command dispatcher (Plan 2 Task 7).
 *
 * Each test invokes `dispatchUserCommand` with `stdio: "pipe"` so the test
 * can capture child stdout/stderr without polluting the test runner's own
 * streams. The production caller (`bin/lich.ts`) leaves stdio defaulting
 * to `"inherit"` so the user sees streaming output — the test override is
 * purely so we can make assertions.
 *
 * Tests intentionally use tiny shell commands (printenv, echo, pwd) so the
 * full suite stays under a second even with ~10 spawns.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchUserCommand } from "../../../src/commands/dispatch.js";
import type { LichConfig } from "../../../src/config/types.js";
import type { Worktree } from "../../../src/worktree/detect.js";
import type { AllocatedPorts } from "../../../src/state/snapshot.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so the `pwd` test's
  // string comparison doesn't trip on the symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "lich-dispatch-test-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const worktree: Worktree = {
  name: "feature-x",
  id: "abc123def456",
  path: "/tmp/feature-x",
  stack_id: "feature-x-abc123de",
};

const noPorts: AllocatedPorts = { compose: {}, owned: {} };

/**
 * Spawn the dispatcher with stdio=pipe and capture stdout/stderr as strings.
 * Returns the result alongside the captured output so tests can assert on
 * both the exit code and the child's I/O.
 *
 * Implementation note: we can't get the captured-stdio strings out of
 * `dispatchUserCommand` directly because it returns only the exit code (by
 * design — the production path is `stdio: "inherit"`). The cleanest way to
 * capture without re-architecting dispatch is to invoke it inside a wrapper
 * that spawns the dispatcher's child but ALSO returns the stdio handles.
 * Rather than do that, we use a simpler approach: monkey-patch a helper that
 * forces stdio="pipe" and re-spawns matching the dispatcher's exact contract.
 *
 * That's overkill — the simpler option is to inject `stdio: "pipe"`, capture
 * what the child writes via the returned-from-spawn handle, and have the
 * dispatcher expose that handle. But the issue calls for "production code
 * uses inherit but tests can pass a custom stdio" — so we wire stdout/stderr
 * collection by passing `"pipe"` and reading the underlying child via a
 * side-channel installed by re-running through a helper. Concretely: we
 * write the child's output to a file via shell redirection inside the cmd
 * itself, then read the file. This is portable, doesn't require dispatcher
 * surgery, and matches what "tests can pass a custom stdio" means in spirit
 * — the test controls the child's I/O destination.
 *
 * Each test that needs to assert on output passes a command that redirects
 * to a file path in `tmp` and then reads that file.
 */
function baseInput(
  overrides: Partial<Parameters<typeof dispatchUserCommand>[0]> & {
    name: string;
  },
): Parameters<typeof dispatchUserCommand>[0] {
  return {
    name: overrides.name,
    extraArgv: overrides.extraArgv ?? [],
    config: overrides.config ?? { version: "1" },
    worktree: overrides.worktree ?? worktree,
    allocatedPorts: overrides.allocatedPorts ?? noPorts,
    projectRoot: overrides.projectRoot ?? tmp,
    envGroupOverride: overrides.envGroupOverride,
    signal: overrides.signal,
    stdio: overrides.stdio,
    stderr: overrides.stderr,
  };
}

// ---------------------------------------------------------------------------
// Unknown command
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — unknown command", () => {
  it("returns 127 with helpful stderr for unknown command name", async () => {
    const errLines: string[] = [];
    const result = await dispatchUserCommand(
      baseInput({
        name: "ghost",
        extraArgv: [],
        config: { version: "1" },
        worktree,
        allocatedPorts: noPorts,
        projectRoot: tmp,
        stderr: (s) => errLines.push(s),
      }),
    );
    expect(result.exitCode).toBe(127);
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines.join("\n")).toContain("unknown command 'ghost'");
    // The hint nudges the user toward the discovery surface.
    expect(errLines.join("\n")).toContain("lich help");
  });

  it("returns 127 when config.commands is absent entirely", async () => {
    const errLines: string[] = [];
    const result = await dispatchUserCommand(
      baseInput({
        name: "anything",
        extraArgv: [],
        config: { version: "1" }, // no commands: section
        worktree,
        allocatedPorts: noPorts,
        projectRoot: tmp,
        stderr: (s) => errLines.push(s),
      }),
    );
    expect(result.exitCode).toBe(127);
    expect(errLines.join("\n")).toContain("unknown command 'anything'");
  });
});

// ---------------------------------------------------------------------------
// Env_group resolution
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — env_group resolution", () => {
  it("runs the command with the stack group env by default", async () => {
    // Capture stdout via shell redirection into a file. The cmd writes
    // MY_VAR's value to a marker file; the test then reads it.
    const marker = join(tmp, "stdout.txt");
    const config: LichConfig = {
      version: "1",
      env: { MY_VAR: "from-top-level" },
      commands: {
        "show-env": {
          // `printenv` exits non-zero if the var is unset; redirect to file
          // so the test can read the value.
          cmd: `printenv MY_VAR > ${JSON.stringify(marker)}`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "show-env",
        config,
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("from-top-level");
  });

  it("--env-group override changes which group is loaded", async () => {
    // Each group bakes both the data var (MY_VAR) AND the output path (OUT)
    // so the cmd can stand alone — no per-command env injection needed.
    const markerA = join(tmp, "a.txt");
    const markerB = join(tmp, "b.txt");
    const config: LichConfig = {
      version: "1",
      env_groups: {
        groupA: { env: { MY_VAR: "from-A", OUT: markerA } },
        groupB: { env: { MY_VAR: "from-B", OUT: markerB } },
      },
      commands: {
        "show-env": {
          cmd: `printenv MY_VAR > "$OUT"`,
          env_group: "groupA",
        },
      },
    };

    // No override → uses the yaml's env_group: groupA. Wrote markerA.
    const rA = await dispatchUserCommand(
      baseInput({ name: "show-env", config }),
    );
    expect(rA.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(markerA, "utf8").trim()).toBe("from-A");

    // Override at invocation time → uses groupB instead. Wrote markerB.
    const rB = await dispatchUserCommand(
      baseInput({
        name: "show-env",
        config,
        envGroupOverride: "groupB",
      }),
    );
    expect(rB.exitCode).toBe(0);
    expect(readFileSync(markerB, "utf8").trim()).toBe("from-B");
  });

  it("per-command env overrides win over group env", async () => {
    const marker = join(tmp, "winner.txt");
    const config: LichConfig = {
      version: "1",
      env_groups: {
        base: { env: { SHARED: "from-group", OUT: marker } },
      },
      commands: {
        "show-env": {
          cmd: `printenv SHARED > "$OUT"`,
          env_group: "base",
          env: { SHARED: "from-per-command" }, // later wins
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "show-env", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("from-per-command");
  });

  it("falls back to the built-in stack group when neither override nor per-command env_group is set", async () => {
    // No env_group anywhere → dispatch uses "stack" which is the top-level
    // env pipeline (plus auto-injects LICH_WORKTREE / LICH_STACK_ID).
    const marker = join(tmp, "stack.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        "show-stack-id": {
          cmd: `printenv LICH_STACK_ID > "$OUT"`,
          // no env_group: → falls back to "stack"
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "show-stack-id", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(worktree.stack_id);
  });
});

// ---------------------------------------------------------------------------
// Argv forwarding
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — argv forwarding", () => {
  it("extra argv is forwarded to the underlying cmd via \"$@\"", async () => {
    const marker = join(tmp, "argv.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        echo: {
          // `"$@"` expands to every forwarded arg, space-separated.
          cmd: `echo "$@" > "$OUT"`,
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "echo",
        config,
        extraArgv: ["--filter", "foo", "bar"],
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("--filter foo bar");
  });

  it("empty extra argv leaves $@ empty", async () => {
    const marker = join(tmp, "empty.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        // Print a marker so we can distinguish "ran with no args" from
        // "didn't run at all".
        echo: { cmd: `echo "got:[$@]" > "$OUT"` },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "echo", config, extraArgv: [] }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("got:[]");
  });

  it("preserves flag-like extras that would otherwise be parsed by sh", async () => {
    // `--filter` is the canonical "flag that's only meaningful to the
    // wrapped tool, not to sh." The dispatcher's `--` separator ensures sh
    // doesn't try to re-interpret it.
    const marker = join(tmp, "flag.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: { echo: { cmd: `echo "$1" "$2" > "$OUT"` } },
    };
    const result = await dispatchUserCommand(
      baseInput({
        name: "echo",
        config,
        extraArgv: ["--filter", "smoke"],
      }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe("--filter smoke");
  });
});

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — cwd", () => {
  it("cwd is resolved relative to projectRoot", async () => {
    // Create apps/api/ inside the project root, then run `pwd > marker`
    // with cwd: apps/api and verify the resolved path matches.
    const subdir = join(tmp, "apps", "api");
    mkdirSync(subdir, { recursive: true });
    const marker = join(tmp, "where.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: {
        wherefore: {
          cmd: `pwd > "$OUT"`,
          cwd: "apps/api",
        },
      },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "wherefore", config }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    // Use realpath for the comparison side too — on macOS the cmd may
    // resolve symlinks in `pwd` output (BSD pwd does not always but bash
    // sometimes does).
    expect(readFileSync(marker, "utf8").trim()).toBe(subdir);
  });

  it("defaults cwd to projectRoot when no cwd is set", async () => {
    const marker = join(tmp, "default-cwd.txt");
    const config: LichConfig = {
      version: "1",
      env: { OUT: marker },
      commands: { wherefore: { cmd: `pwd > "$OUT"` } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "wherefore", config, projectRoot: tmp }),
    );
    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(marker, "utf8").trim()).toBe(tmp);
  });
});

// ---------------------------------------------------------------------------
// Exit code propagation
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — exit codes", () => {
  it("propagates the child's non-zero exit code", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { fail: { cmd: "exit 7" } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "fail", config }),
    );
    expect(result.exitCode).toBe(7);
  });

  it("propagates zero exit code from a successful command", async () => {
    const config: LichConfig = {
      version: "1",
      commands: { ok: { cmd: "true" } },
    };
    const result = await dispatchUserCommand(
      baseInput({ name: "ok", config }),
    );
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — abort signal", () => {
  it("abort signal kills the child and returns 130", async () => {
    // Spawn a sleep that would normally run for 30s; abort after 50ms.
    // The child should receive SIGINT and the dispatcher should resolve
    // with exit code 130 regardless of what the killed child's code was.
    const config: LichConfig = {
      version: "1",
      commands: { sleep: { cmd: "sleep 30" } },
    };
    const controller = new AbortController();
    const promise = dispatchUserCommand(
      baseInput({ name: "sleep", config, signal: controller.signal }),
    );
    // Give the spawn a moment to actually happen before aborting.
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.exitCode).toBe(130);
  });

  it("abort signal already-fired before dispatch still returns 130", async () => {
    // Race: caller aborted between deciding to dispatch and actually
    // calling. The dispatcher should still wire up cleanly and resolve
    // with 130 (rather than racing into a "command ran successfully"
    // exit-code-0 outcome).
    const config: LichConfig = {
      version: "1",
      commands: { sleep: { cmd: "sleep 30" } },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchUserCommand(
      baseInput({ name: "sleep", config, signal: controller.signal }),
    );
    expect(result.exitCode).toBe(130);
  });
});

// ---------------------------------------------------------------------------
// Group resolution errors
// ---------------------------------------------------------------------------

describe("dispatchUserCommand — group resolution errors", () => {
  it("propagates GroupResolveError when the referenced env_group is missing", async () => {
    const config: LichConfig = {
      version: "1",
      commands: {
        broken: {
          cmd: "true",
          env_group: "ghost-group",
        },
      },
    };
    // The dispatcher doesn't catch resolver errors — they bubble out so the
    // bin-layer (or test) sees them. This is intentional: validate
    // (Plan 2 Task 16) is the right place to surface the friendly error
    // message; dispatch is the runtime hot path and trusts validation.
    await expect(
      dispatchUserCommand(baseInput({ name: "broken", config })),
    ).rejects.toThrow(/ghost-group/);
  });

  it("propagates GroupResolveError when --env-group= override targets a missing group", async () => {
    const config: LichConfig = {
      version: "1",
      env_groups: { real: { env: { X: "1" } } },
      commands: { broken: { cmd: "true" } },
    };
    await expect(
      dispatchUserCommand(
        baseInput({
          name: "broken",
          config,
          envGroupOverride: "imaginary",
        }),
      ),
    ).rejects.toThrow(/imaginary/);
  });
});
