import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendStarted,
  readStartedLog,
  startedLogPath,
  type StartedEntry,
} from "../../../src/state/started-log.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test points LICH_HOME at a fresh tmpdir so reads and writes are
// hermetic — the real `~/.lich/started.log` is never touched.
// ---------------------------------------------------------------------------

let home: string;
let prevLichHome: string | undefined;
let originalStderrWrite: typeof process.stderr.write;
let stderrChunks: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-started-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;

  // Capture stderr so the malformed-line warning test can assert on it
  // without spamming the test runner's own output.
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

function stderrText(): string {
  return stderrChunks.join("");
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

describe("startedLogPath", () => {
  it("lives directly under $LICH_HOME (NOT under stacks/)", () => {
    // Critical for the rescue use case: a `rm -rf ~/.lich/stacks/` —
    // exactly the symptom rescue exists to recover from — must NOT
    // also nuke the rescue log. The log file therefore sits OUTSIDE
    // stacks/.
    expect(startedLogPath()).toBe(join(home, "started.log"));
  });
});

// ---------------------------------------------------------------------------
// appendStarted: basic round-trip
// ---------------------------------------------------------------------------

describe("appendStarted + readStartedLog", () => {
  it("writes a valid NDJSON line that round-trips", async () => {
    const entry: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "stack-aaa11111",
      kind: "pid",
      service: "api",
      pid: 12345,
      cmd: "bun run dev",
      cwd: "/tmp/some-worktree",
    };

    await appendStarted(entry);

    // File now exists on disk with exactly one line.
    const raw = readFileSync(startedLogPath(), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    // The line parses as valid JSON.
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toEqual(entry);

    // And readStartedLog yields the entry back.
    const entries = await readStartedLog();
    expect(entries).toEqual([entry]);
  });

  it("appends multiple entries, preserving order", async () => {
    const a: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 1,
      cmd: "echo a",
      cwd: "/tmp/a",
    };
    const b: StartedEntry = {
      ts: "2026-05-24T03:00:01.000Z",
      stack_id: "s1",
      kind: "compose",
      project: "lich-s1",
      files: ["/tmp/compose.yml"],
      cwd: "/tmp/a",
      compose_cli: "docker",
    };
    const c: StartedEntry = {
      ts: "2026-05-24T03:00:02.000Z",
      stack_id: "s2",
      kind: "owned",
      service: "supabase",
      cmd: "supabase start",
      stop_cmd: "supabase stop",
      cwd: "/tmp/b",
      env: { SUPABASE_PROJECT_ID: "p-abc" },
    };

    await appendStarted(a);
    await appendStarted(b);
    await appendStarted(c);

    const entries = await readStartedLog();
    expect(entries).toEqual([a, b, c]);
  });

  it("round-trips all three entry kinds without dropping fields", async () => {
    const entries: StartedEntry[] = [
      {
        ts: "2026-05-24T03:00:00.000Z",
        stack_id: "s1",
        kind: "pid",
        service: "api",
        pid: 12345,
        cmd: "bun run dev",
        cwd: "/tmp/api-cwd",
      },
      {
        ts: "2026-05-24T03:00:01.000Z",
        stack_id: "s1",
        kind: "compose",
        project: "lich-s1",
        files: ["/tmp/compose.yml", "/tmp/override.yml"],
        cwd: "/tmp/cwd",
        compose_cli: "podman",
      },
      {
        ts: "2026-05-24T03:00:02.000Z",
        stack_id: "s1",
        kind: "owned",
        service: "supabase",
        cmd: "supabase start",
        stop_cmd: "supabase stop",
        cwd: "/tmp/cwd",
        env: {
          SUPABASE_PROJECT_ID: "p-deadbeef",
          PATH: "/usr/local/bin:/usr/bin",
        },
      },
    ];

    for (const e of entries) {
      await appendStarted(e);
    }
    const got = await readStartedLog();
    expect(got).toEqual(entries);
  });

  it("creates the parent directory if it does not exist (rm-rf recovery)", async () => {
    // Simulate the rescue scenario: someone wiped ~/.lich/ entirely.
    rmSync(home, { recursive: true, force: true });
    // The directory genuinely doesn't exist now.
    expect(existsSync(home)).toBe(false);

    const entry: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 12345,
      cmd: "bun run dev",
      cwd: "/tmp/x",
    };

    // appendStarted must recover from ENOENT by creating the dir.
    await appendStarted(entry);

    // Log got created, entry got written.
    expect(existsSync(startedLogPath())).toBe(true);
    const entries = await readStartedLog();
    expect(entries).toEqual([entry]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — O_APPEND atomicity
//
// The promise: parallel `lich up` invocations append concurrently without
// corrupting each other's lines. POSIX `appendFile` opens with O_APPEND,
// which (for writes under PIPE_BUF, typically 4096) is atomic per write.
// We don't directly assert kernel behavior; we assert the observable
// outcome — N concurrent appends yield N parseable lines, each matching
// one input.
// ---------------------------------------------------------------------------

describe("appendStarted — concurrent writers", () => {
  it("100 concurrent appends all land as complete, parseable lines", async () => {
    const N = 100;
    const inputs: StartedEntry[] = Array.from({ length: N }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 4, 24, 3, 0, i)).toISOString(),
      stack_id: `s-${i.toString().padStart(3, "0")}`,
      kind: "pid",
      service: `svc-${i}`,
      pid: 10000 + i,
      cmd: `cmd-${i}`,
      cwd: "/tmp/x",
    }));

    await Promise.all(inputs.map((e) => appendStarted(e)));

    // Read by direct slurp (not via readStartedLog) so the test is
    // purely about line integrity: if any write got torn, the parse
    // here will throw or the count will be off.
    const raw = readFileSync(startedLogPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(N);

    // Every line must parse cleanly.
    const parsed: StartedEntry[] = lines.map((l) => JSON.parse(l));
    // The order isn't guaranteed under concurrency, but the SET of
    // entries must match exactly.
    const sortByPid = (a: StartedEntry, b: StartedEntry): number => {
      if (a.kind !== "pid" || b.kind !== "pid") return 0;
      return a.pid - b.pid;
    };
    expect([...parsed].sort(sortByPid)).toEqual([...inputs].sort(sortByPid));
  });
});

// ---------------------------------------------------------------------------
// readStartedLog: empty + missing
// ---------------------------------------------------------------------------

describe("readStartedLog", () => {
  it("returns [] when the file does not exist", async () => {
    expect(await readStartedLog()).toEqual([]);
    // No warning printed for the missing-file case — it's the normal
    // "fresh machine" state.
    expect(stderrText()).toBe("");
  });

  it("returns [] when the file exists but is empty", async () => {
    writeFileSync(startedLogPath(), "", "utf8");
    expect(await readStartedLog()).toEqual([]);
  });

  it("returns [] when the file is only blank lines", async () => {
    writeFileSync(startedLogPath(), "\n\n\n", "utf8");
    expect(await readStartedLog()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readStartedLog: malformed lines
// ---------------------------------------------------------------------------

describe("readStartedLog — malformed lines", () => {
  it("drops unparseable lines and warns on stderr", async () => {
    const good: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 1,
      cmd: "x",
      cwd: "/tmp",
    };
    // Two valid lines, two junk lines.
    const raw = [
      JSON.stringify(good),
      "this is not json",
      JSON.stringify({ ...good, pid: 2 }),
      "{ unterminated",
      "",
    ].join("\n");
    writeFileSync(startedLogPath(), raw, "utf8");

    const entries = await readStartedLog();
    expect(entries).toHaveLength(2);
    expect((entries[0] as { pid: number }).pid).toBe(1);
    expect((entries[1] as { pid: number }).pid).toBe(2);

    // Warning fired once and mentions the count.
    const warn = stderrText();
    expect(warn).toContain("skipped 2 malformed");
    expect(warn).toContain("started.log");
  });

  it("uses singular 'line' in the warning when exactly one is malformed", async () => {
    writeFileSync(startedLogPath(), "garbage\n", "utf8");
    await readStartedLog();
    expect(stderrText()).toContain("skipped 1 malformed line in started.log");
    expect(stderrText()).not.toContain("lines");
  });

  it("emits no warning when every line is valid", async () => {
    const good: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 1,
      cmd: "x",
      cwd: "/tmp",
    };
    writeFileSync(
      startedLogPath(),
      JSON.stringify(good) + "\n" + JSON.stringify({ ...good, pid: 2 }) + "\n",
      "utf8",
    );
    await readStartedLog();
    expect(stderrText()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Partial-write simulation
//
// Crash-mid-write: the final line has valid JSON shape but no trailing
// newline. We want the parser to either accept it (if it parses) OR
// drop it cleanly (if it's truncated). Both cases test below.
// ---------------------------------------------------------------------------

describe("readStartedLog — partial last line", () => {
  it("returns the valid prefix and drops a truncated trailing line", async () => {
    const good: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 1,
      cmd: "ok",
      cwd: "/tmp",
    };
    // First write a clean line, then a truncated one (no closing brace,
    // no trailing newline) — mimics a crash mid-fwrite.
    const raw =
      JSON.stringify(good) +
      "\n" +
      '{"ts":"2026-05-24T03:00:01.000Z","stack_id":"s1","kind":"pid","service":"api","pid":2';
    writeFileSync(startedLogPath(), raw, "utf8");

    const entries = await readStartedLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(good);
    expect(stderrText()).toContain("skipped 1 malformed");
  });

  it("returns a complete-JSON last line even when it lacks a trailing newline", async () => {
    // Strictly speaking the contract calls for `\n` per line, but a
    // final write that landed completely-but-without-the-terminator
    // should still be readable rather than dropped. (The complete-JSON
    // case parses; partial-JSON case is the previous test.)
    const a: StartedEntry = {
      ts: "2026-05-24T03:00:00.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 1,
      cmd: "a",
      cwd: "/tmp",
    };
    const b: StartedEntry = {
      ts: "2026-05-24T03:00:01.000Z",
      stack_id: "s1",
      kind: "pid",
      service: "api",
      pid: 2,
      cmd: "b",
      cwd: "/tmp",
    };
    const raw = JSON.stringify(a) + "\n" + JSON.stringify(b);
    writeFileSync(startedLogPath(), raw, "utf8");

    const entries = await readStartedLog();
    expect(entries).toEqual([a, b]);
    expect(stderrText()).toBe("");
  });
});
