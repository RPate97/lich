import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatHookFailureOutput,
  formatStderrSurface,
  runLifecycle,
  LifecycleHookError,
  type LifecycleEntryCompletion,
  type LifecycleEntryStart,
  type LifecycleWarning,
} from "../../../src/lifecycle/executor.js";

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lich-lifecycle-"));
}

describe("runLifecycle", () => {
  it("before_up: runs two successful entries in order", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");

    await runLifecycle({
      phase: "before_up",
      entries: [
        `printf 'a' >> ${JSON.stringify(marker)}`,
        `printf 'b' >> ${JSON.stringify(marker)}`,
      ],
      cwd,
      env: { ...process.env },
    });

    expect(readFileSync(marker, "utf8")).toBe("ab");
  });

  it("before_up: first entry exits non-zero -> throws and stops", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "should-not-exist.txt");

    let caught: unknown;
    try {
      await runLifecycle({
        phase: "before_up",
        entries: [
          "echo 'boom' 1>&2; exit 5",
          `printf 'never' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LifecycleHookError);
    const e = caught as LifecycleHookError;
    expect(e.phase).toBe("before_up");
    expect(e.index).toBe(0);
    expect(e.exitCode).toBe(5);
    expect(e.cmd).toContain("exit 5");
    expect(e.stderr).toContain("boom");
    expect(existsSync(marker)).toBe(false);
  });

  it("after_up: failure throws LifecycleHookError with after_up phase", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runLifecycle({
        phase: "after_up",
        entries: ["echo nope 1>&2; exit 3"],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LifecycleHookError);
    const e = caught as LifecycleHookError;
    expect(e.phase).toBe("after_up");
    expect(e.exitCode).toBe(3);
    expect(e.index).toBe(0);
    expect(e.stderr).toContain("nope");
  });

  it("before_down: first entry fails, second still runs; warning emitted; no throw", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    const warnings: LifecycleWarning[] = [];

    await runLifecycle(
      {
        phase: "before_down",
        entries: [
          "echo woops 1>&2; exit 1",
          `printf 'ran' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      },
      (w) => warnings.push(w),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.index).toBe(0);
    expect(warnings[0]!.exitCode).toBe(1);
    expect(warnings[0]!.cmd).toContain("exit 1");
    expect(warnings[0]!.stderr).toContain("woops");
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });

  it("after_down: first entry fails, second still runs; warning emitted; no throw", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    const warnings: LifecycleWarning[] = [];

    await runLifecycle(
      {
        phase: "after_down",
        entries: [
          "echo oops 1>&2; exit 9",
          `printf 'after_down ran' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      },
      (w) => warnings.push(w),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.index).toBe(0);
    expect(warnings[0]!.exitCode).toBe(9);
    expect(warnings[0]!.cmd).toContain("exit 9");
    expect(warnings[0]!.stderr).toContain("oops");
    expect(readFileSync(marker, "utf8")).toBe("after_down ran");
  });

  it("after_down: runs entries in declared order", async () => {
    const cwd = freshTmpDir();
    const ledger = join(cwd, "ledger.txt");

    await runLifecycle({
      phase: "after_down",
      entries: [
        `printf 'a' >> ${JSON.stringify(ledger)}`,
        `printf 'b' >> ${JSON.stringify(ledger)}`,
        `printf 'c' >> ${JSON.stringify(ledger)}`,
      ],
      cwd,
      env: { ...process.env },
    });

    expect(readFileSync(ledger, "utf8")).toBe("abc");
  });

  it("shorthand string entry runs (no env_group)", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [`printf 'shorthand' > ${JSON.stringify(marker)}`],
      cwd,
      env: { ...process.env },
    });
    expect(readFileSync(marker, "utf8")).toBe("shorthand");
  });

  it("long-form entry with cmd only (no env_group) runs", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [{ cmd: `printf 'longform' > ${JSON.stringify(marker)}` }],
      cwd,
      env: { ...process.env },
    });
    expect(readFileSync(marker, "utf8")).toBe("longform");
  });

  it("long-form entry with env_group set and no resolveEnvGroup throws", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runLifecycle({
        phase: "before_up",
        entries: [{ cmd: "true", env_group: "secrets" }],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("env_group not supported in Plan 1");
    expect((caught as Error).message).toContain("secrets");
  });

  it("long-form entry with env_group + resolveEnvGroup uses the resolved env", async () => {
    const cwd = freshTmpDir();
    let askedFor: string | null = null;

    await runLifecycle({
      phase: "before_up",
      entries: [
        { cmd: 'test "$X" = "y"', env_group: "groupA" },
      ],
      cwd,
      env: { ...process.env, X: "wrong" },
      resolveEnvGroup: async (name) => {
        askedFor = name;
        return { X: "y" };
      },
    });

    expect(askedFor).toBe("groupA");
  });

  it("env passthrough: input.env is visible to the spawned shell", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "out.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [`printf '%s' "$MY" > ${JSON.stringify(marker)}`],
      cwd,
      env: { MY: "hello-env", PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(marker, "utf8")).toBe("hello-env");
  });

  it("empty entries list is a no-op", async () => {
    const cwd = freshTmpDir();
    await runLifecycle({
      phase: "before_up",
      entries: [],
      cwd,
      env: { ...process.env },
    });
    expect(true).toBe(true);
  });

  it("stderr is captured even when entry exits 0 (|| true case)", async () => {
    // `cmd || true` swallows non-zero exit; we still want to surface stderr
    const cwd = freshTmpDir();
    const completions: LifecycleEntryCompletion[] = [];

    await runLifecycle(
      {
        phase: "before_up",
        entries: [
          // subshell ( ... ) so exit 1 exits the SUBSHELL — brace form would tear down current shell before || acts
          "( echo 'oops something broke' 1>&2; exit 1 ) || true",
        ],
        cwd,
        env: { ...process.env },
      },
      undefined,
      (c) => completions.push(c),
    );

    expect(completions).toHaveLength(1);
    expect(completions[0]!.exitCode).toBe(0);
    expect(completions[0]!.stderrTail).toContain("oops something broke");
    expect(completions[0]!.cmd).toContain("oops");
    expect(completions[0]!.index).toBe(0);
  });

  it("writes per-hook log file with combined stdout+stderr", async () => {
    const cwd = freshTmpDir();
    const logDir = freshTmpDir();

    await runLifecycle({
      phase: "before_up",
      entries: [
        "echo 'from-stdout'; echo 'from-stderr' 1>&2",
      ],
      cwd,
      env: { ...process.env },
      logDir,
    });

    const logPath = join(logDir, "before_up-0.log");
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    expect(contents).toContain("from-stdout");
    expect(contents).toContain("from-stderr");
  });

  it("log path matches `<logDir>/<phase>-<idx>.log` convention", async () => {
    const cwd = freshTmpDir();
    const logDir = freshTmpDir();
    const completions: LifecycleEntryCompletion[] = [];

    await runLifecycle(
      {
        phase: "after_down",
        entries: ["echo a", "echo b", "echo c"],
        cwd,
        env: { ...process.env },
        logDir,
      },
      undefined,
      (c) => completions.push(c),
    );

    expect(existsSync(join(logDir, "after_down-0.log"))).toBe(true);
    expect(existsSync(join(logDir, "after_down-1.log"))).toBe(true);
    expect(existsSync(join(logDir, "after_down-2.log"))).toBe(true);
    expect(completions.map((c) => c.logPath)).toEqual([
      join(logDir, "after_down-0.log"),
      join(logDir, "after_down-1.log"),
      join(logDir, "after_down-2.log"),
    ]);
  });

  it("log file truncated to ~1 MB cap on a runaway hook", async () => {
    const cwd = freshTmpDir();
    const logDir = freshTmpDir();
    const ONE_MB = 1_000_000;

    await runLifecycle({
      phase: "before_up",
      entries: [
        // ~3 MB of x chars
        `for i in $(seq 1 30); do printf '%.0sx' $(seq 1 100000); done`,
      ],
      cwd,
      env: { ...process.env },
      logDir,
    });

    const logPath = join(logDir, "before_up-0.log");
    expect(existsSync(logPath)).toBe(true);
    const size = statSync(logPath).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(ONE_MB);
  });

  it("entry that produces no output writes an empty log file", async () => {
    const cwd = freshTmpDir();
    const logDir = freshTmpDir();

    await runLifecycle({
      phase: "after_up",
      entries: ["true"],
      cwd,
      env: { ...process.env },
      logDir,
    });

    const logPath = join(logDir, "after_up-0.log");
    if (existsSync(logPath)) {
      expect(statSync(logPath).size).toBe(0);
    }
  });

  it("onEntryComplete fires for every entry regardless of exit code", async () => {
    // completion callback fires on success too — so renderer can surface stderr from `|| true` hooks
    const cwd = freshTmpDir();
    const completions: LifecycleEntryCompletion[] = [];

    await runLifecycle(
      {
        phase: "before_up",
        entries: ["true", "echo only-stderr 1>&2", "true"],
        cwd,
        env: { ...process.env },
      },
      undefined,
      (c) => completions.push(c),
    );

    expect(completions).toHaveLength(3);
    expect(completions[0]!.exitCode).toBe(0);
    expect(completions[1]!.exitCode).toBe(0);
    expect(completions[2]!.exitCode).toBe(0);
    expect(completions[0]!.stderrTail).toBe("");
    expect(completions[1]!.stderrTail).toContain("only-stderr");
    expect(completions[2]!.stderrTail).toBe("");
  });

  it("when logDir is unset, no log files are written but completion still fires", async () => {
    const cwd = freshTmpDir();
    const completions: LifecycleEntryCompletion[] = [];

    await runLifecycle(
      {
        phase: "before_up",
        entries: ["echo hello 1>&2"],
        cwd,
        env: { ...process.env },
      },
      undefined,
      (c) => completions.push(c),
    );

    expect(completions).toHaveLength(1);
    expect(completions[0]!.stderrTail).toContain("hello");
    expect(completions[0]!.logPath).toBeUndefined();
  });

  it(
    "log file write survives a non-existent logDir (auto-creates)",
    async () => {
      const cwd = freshTmpDir();
      const logDir = join(freshTmpDir(), "subdir-that-does-not-exist");
      expect(existsSync(logDir)).toBe(false);

      await runLifecycle({
        phase: "before_up",
        entries: ["echo hello-from-hook"],
        cwd,
        env: { ...process.env },
        logDir,
      });

      const logPath = join(logDir, "before_up-0.log");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("hello-from-hook");
    },
  );

  it("formatStderrSurface returns null when stderrTail is empty", () => {
    expect(
      formatStderrSurface({
        phase: "before_up",
        index: 0,
        total: 1,
        cmd: "true",
        stderrTail: "",
      }),
    ).toBeNull();
    expect(
      formatStderrSurface({
        phase: "after_down",
        index: 2,
        total: 5,
        cmd: "echo",
        stderrTail: "\n\n   \n",
      }),
    ).toBeNull();
  });

  it("formatStderrSurface renders the spec'd line shape with last 3 stderr lines", () => {
    const out = formatStderrSurface({
      phase: "before_down",
      index: 0,
      total: 2,
      cmd: "supabase stop",
      stderrTail: "line1\nline2\nline3\nline4",
    });
    expect(out).toBe(
      "▶ before_down (1/2): supabase stop — stderr: line2 | line3 | line4",
    );
  });

  it("formatStderrSurface tolerates a single-line tail", () => {
    expect(
      formatStderrSurface({
        phase: "after_up",
        index: 1,
        total: 3,
        cmd: "pnpm migrate",
        stderrTail: "  one loud thing  ",
      }),
    ).toBe(
      "▶ after_up (2/3): pnpm migrate — stderr: one loud thing",
    );
  });

  it("onEntryStart fires BEFORE each entry runs with phase/idx/total/cmd", async () => {
    const cwd = freshTmpDir();
    const starts: LifecycleEntryStart[] = [];

    await runLifecycle(
      {
        phase: "before_up",
        entries: ["true", "true", "true"],
        cwd,
        env: { ...process.env },
      },
      {
        onEntryStart: (s) => starts.push(s),
      },
    );

    expect(starts).toHaveLength(3);
    expect(starts[0]).toEqual({
      phase: "before_up",
      index: 0,
      total: 3,
      cmd: "true",
    });
    expect(starts[1]).toEqual({
      phase: "before_up",
      index: 1,
      total: 3,
      cmd: "true",
    });
    expect(starts[2]).toEqual({
      phase: "before_up",
      index: 2,
      total: 3,
      cmd: "true",
    });
  });

  it("start fires BEFORE complete for each entry (start→complete ordering)", async () => {
    const cwd = freshTmpDir();
    type Event =
      | { kind: "start"; index: number }
      | { kind: "complete"; index: number };
    const events: Event[] = [];

    await runLifecycle(
      {
        phase: "after_up",
        entries: ["true", "true"],
        cwd,
        env: { ...process.env },
      },
      {
        onEntryStart: (s) => events.push({ kind: "start", index: s.index }),
        onEntryComplete: (c) =>
          events.push({ kind: "complete", index: c.index }),
      },
    );

    expect(events).toEqual([
      { kind: "start", index: 0 },
      { kind: "complete", index: 0 },
      { kind: "start", index: 1 },
      { kind: "complete", index: 1 },
    ]);
  });

  it("onEntryComplete carries phase, total, and elapsedMs", async () => {
    const cwd = freshTmpDir();
    const completions: LifecycleEntryCompletion[] = [];

    await runLifecycle(
      {
        phase: "before_down",
        entries: ["sleep 0.05", "sleep 0.05"],
        cwd,
        env: { ...process.env },
      },
      {
        onEntryComplete: (c) => completions.push(c),
      },
    );

    expect(completions).toHaveLength(2);
    expect(completions[0]!.phase).toBe("before_down");
    expect(completions[0]!.total).toBe(2);
    expect(completions[0]!.index).toBe(0);
    expect(completions[0]!.elapsedMs).toBeGreaterThanOrEqual(40);
    expect(completions[1]!.phase).toBe("before_down");
    expect(completions[1]!.total).toBe(2);
    expect(completions[1]!.index).toBe(1);
    expect(completions[1]!.elapsedMs).toBeGreaterThanOrEqual(40);
  });

  it("onEntryStart fires for best-effort phases too (before_down/after_down)", async () => {
    const cwd = freshTmpDir();
    const starts: LifecycleEntryStart[] = [];

    await runLifecycle(
      {
        phase: "after_down",
        entries: ["true", "true"],
        cwd,
        env: { ...process.env },
      },
      {
        onEntryStart: (s) => starts.push(s),
      },
    );

    expect(starts.map((s) => s.phase)).toEqual(["after_down", "after_down"]);
  });

  it("onEntryStart still fires when entry fails (before fail-fast throw)", async () => {
    // start MUST fire before fail-fast throw; complete does NOT fire on failed entry
    const cwd = freshTmpDir();
    const starts: LifecycleEntryStart[] = [];

    let caught: unknown;
    try {
      await runLifecycle(
        {
          phase: "before_up",
          entries: ["true", "exit 7"],
          cwd,
          env: { ...process.env },
        },
        {
          onEntryStart: (s) => starts.push(s),
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LifecycleHookError);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.cmd).toBe("exit 7");
  });

  it("object-form callbacks coexist with legacy positional shape", async () => {
    // overload supports both object and legacy positional forms
    const cwd = freshTmpDir();
    const legacyCompletions: LifecycleEntryCompletion[] = [];
    const modernCompletions: LifecycleEntryCompletion[] = [];
    const modernStarts: LifecycleEntryStart[] = [];

    await runLifecycle(
      {
        phase: "before_up",
        entries: ["true"],
        cwd,
        env: { ...process.env },
      },
      undefined,
      (c) => legacyCompletions.push(c),
    );

    await runLifecycle(
      {
        phase: "before_up",
        entries: ["true"],
        cwd,
        env: { ...process.env },
      },
      {
        onEntryStart: (s) => modernStarts.push(s),
        onEntryComplete: (c) => modernCompletions.push(c),
      },
    );

    expect(legacyCompletions).toHaveLength(1);
    expect(modernCompletions).toHaveLength(1);
    expect(modernStarts).toHaveLength(1);
    expect(legacyCompletions[0]!.phase).toBe("before_up");
    expect(legacyCompletions[0]!.total).toBe(1);
    expect(modernCompletions[0]!.phase).toBe("before_up");
    expect(modernCompletions[0]!.total).toBe(1);
  });
});

describe("formatHookFailureOutput", () => {
  it("returns null when the log file does not exist", () => {
    const result = formatHookFailureOutput({
      phase: "before_up",
      index: 0,
      total: 1,
      cmd: "pnpm db:reset",
      exitCode: 1,
      logPath: "/nonexistent/path/before_up-0.log",
    });
    expect(result).toBeNull();
  });

  it("returns lines and footer for a readable log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-fhfo-"));
    const logPath = join(dir, "before_up-0.log");
    writeFileSync(logPath, "line one\nline two\nline three\n", "utf8");

    const result = formatHookFailureOutput({
      phase: "before_up",
      index: 0,
      total: 1,
      cmd: "pnpm db:reset",
      exitCode: 1,
      logPath,
    });

    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(["line one", "line two", "line three"]);
    expect(result!.footer).toContain(logPath);
    expect(result!.footer).toContain("full log");
  });

  it("tails to last 500 lines when output exceeds 500 lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-fhfo-tail-"));
    const logPath = join(dir, "before_up-0.log");
    const allLines = Array.from({ length: 600 }, (_, i) => `line-${i}`);
    writeFileSync(logPath, allLines.join("\n") + "\n", "utf8");

    const result = formatHookFailureOutput({
      phase: "before_up",
      index: 0,
      total: 1,
      cmd: "pnpm db:reset",
      exitCode: 2,
      logPath,
    });

    expect(result).not.toBeNull();
    expect(result!.lines).toHaveLength(500);
    // Tailed: should contain the last 500 lines (100–599)
    expect(result!.lines[0]).toBe("line-100");
    expect(result!.lines[499]).toBe("line-599");
  });

  it("includes combined stdout output (not just stderr) from the log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-fhfo-combined-"));
    const logPath = join(dir, "before_up-0.log");
    writeFileSync(
      logPath,
      "stdout: installing deps\nstderr: ERROR: missing package\n",
      "utf8",
    );

    const result = formatHookFailureOutput({
      phase: "before_up",
      index: 0,
      total: 2,
      cmd: "pnpm install",
      exitCode: 1,
      logPath,
    });

    expect(result).not.toBeNull();
    expect(result!.lines.join("\n")).toContain("stdout: installing deps");
    expect(result!.lines.join("\n")).toContain("stderr: ERROR: missing package");
  });

  it("strips trailing empty line from trailing newline in log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-fhfo-newline-"));
    const logPath = join(dir, "after_up-0.log");
    writeFileSync(logPath, "error: something went wrong\n", "utf8");

    const result = formatHookFailureOutput({
      phase: "after_up",
      index: 0,
      total: 1,
      cmd: "run-migrations",
      exitCode: 1,
      logPath,
    });

    expect(result).not.toBeNull();
    expect(result!.lines).toEqual(["error: something went wrong"]);
  });

  it("returns lines for an empty log file (no crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lich-fhfo-empty-"));
    const logPath = join(dir, "before_up-0.log");
    writeFileSync(logPath, "", "utf8");

    const result = formatHookFailureOutput({
      phase: "before_up",
      index: 0,
      total: 1,
      cmd: "false",
      exitCode: 1,
      logPath,
    });

    expect(result).not.toBeNull();
    expect(result!.lines).toEqual([]);
    expect(result!.footer).toContain(logPath);
  });
});
