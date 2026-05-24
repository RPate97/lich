import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHelp } from "../../../src/commands/help.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-help-test-"));
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(tmp, "lich.yaml"), body, "utf8");
}

async function run(opts: { commandName?: string; cwd?: string } = {}) {
  return runHelp({
    ...opts,
    cwd: opts.cwd ?? tmp,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

// ---------------------------------------------------------------------------
// List mode — built-in coverage
// ---------------------------------------------------------------------------

describe("runHelp — list mode (no commandName)", () => {
  it("lists every built-in command with a one-line summary", async () => {
    const res = await run();
    expect(res.exitCode).toBe(0);

    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");

    // Every built-in name must appear in the output.
    for (const name of [
      "up",
      "down",
      "logs",
      "urls",
      "stacks",
      "restart",
      "nuke",
      "init",
      "validate",
      "help",
      "exec",
      "env",
    ]) {
      // Match the leading-spaces-then-name format so we don't false-positive
      // on the summary text containing the word "up" etc.
      const re = new RegExp(`^  ${name.replace(":", "\\:")}\\b`, "m");
      expect(out).toMatch(re);
    }
  });

  it("includes a non-empty summary for each built-in", async () => {
    await run();
    const out = stdout.join("\n");
    // Every listed line starts with two spaces, a name, padding, then text.
    // Use the `up` line as a smoke check: it must have non-empty content
    // after the name.
    const upLine = stdout.find((l) => l.match(/^  up\s/));
    expect(upLine).toBeDefined();
    expect(upLine!.replace(/^  up\s+/, "").length).toBeGreaterThan(0);
    // Same for env (the longest-padded short name).
    const envLine = stdout.find((l) => l.match(/^  env\s/));
    expect(envLine).toBeDefined();
    expect(envLine!.replace(/^  env\s+/, "").length).toBeGreaterThan(0);
  });

  it("does NOT list user commands when no lich.yaml is present", async () => {
    const res = await run();
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).not.toContain("User-defined commands");
  });

  it("works in a directory with no lich.yaml (built-ins only)", async () => {
    // No yaml written; tmpdir is empty.
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");
    expect(out).not.toContain("User-defined commands");
  });

  it("includes user-defined commands from lich.yaml when present", async () => {
    writeYaml(`
version: "1"
commands:
  test:e2e:
    cmd: echo hi
    help: |
      Run e2e tests against the live stack.
      Multi-line.
  db:psql:
    cmd: psql "$DATABASE_URL"
    help: Open a psql shell against the local postgres.
`);

    const res = await run();
    expect(res.exitCode).toBe(0);

    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");
    expect(out).toContain("User-defined commands (from lich.yaml):");
    expect(out).toMatch(/^  db:psql\s/m);
    expect(out).toMatch(/^  test:e2e\s/m);

    // Summary for test:e2e should be its FIRST line, not the whole block.
    const e2eLine = stdout.find((l) => l.match(/^  test:e2e\s/));
    expect(e2eLine).toBeDefined();
    expect(e2eLine).toContain("Run e2e tests against the live stack.");
    expect(e2eLine).not.toContain("Multi-line.");

    // db:psql summary should appear too (single-line help string).
    const psqlLine = stdout.find((l) => l.match(/^  db:psql\s/));
    expect(psqlLine).toContain("Open a psql shell");
  });

  it("sorts user commands alphabetically", async () => {
    writeYaml(`
version: "1"
commands:
  z:last:
    cmd: echo z
    help: zzz
  a:first:
    cmd: echo a
    help: aaa
  m:middle:
    cmd: echo m
    help: mmm
`);

    await run();
    const out = stdout.join("\n");
    const aIdx = out.indexOf("a:first");
    const mIdx = out.indexOf("m:middle");
    const zIdx = out.indexOf("z:last");
    expect(aIdx).toBeGreaterThan(0);
    expect(mIdx).toBeGreaterThan(aIdx);
    expect(zIdx).toBeGreaterThan(mIdx);
  });

  it("shows (no help text) for user commands without a help: field", async () => {
    writeYaml(`
version: "1"
commands:
  bare:cmd:
    cmd: echo bare
`);
    await run();
    const out = stdout.join("\n");
    expect(out).toMatch(/^  bare:cmd\s+\(no help text\)/m);
  });

  it("does NOT crash when lich.yaml is malformed", async () => {
    // A broken yaml file shouldn't prevent the built-in listing from
    // rendering. lich help is the discovery surface; lich validate is the
    // diagnostic surface.
    writeYaml(`
version: "1"
commands: not-an-object-at-all
`);
    const res = await run();
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");
    expect(out).not.toContain("User-defined commands");
  });

  it("does NOT list a User-defined commands section when commands: is empty", async () => {
    writeYaml(`
version: "1"
commands: {}
`);
    const res = await run();
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).not.toContain("User-defined commands");
  });
});

// ---------------------------------------------------------------------------
// Per-command mode — built-ins
// ---------------------------------------------------------------------------

describe("runHelp — per-command mode for built-ins", () => {
  it("shows long help for a built-in command name", async () => {
    const res = await run({ commandName: "up" });
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const out = stdout.join("\n");
    expect(out).toContain("Usage: lich up");
    // Long help is multi-line; confirm something past the usage line is
    // present so we know the full text printed.
    expect(out.split("\n").length).toBeGreaterThan(2);
  });

  it("shows long help for `lich help help` (self-describing)", async () => {
    const res = await run({ commandName: "help" });
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).toContain("Usage: lich help");
  });

  it("does NOT load lich.yaml when asking for a built-in's help", async () => {
    // Write a broken yaml. If we accidentally loaded it for a built-in,
    // parseConfig would still return null (caught) but the test still pins
    // intent: built-in help is zero-IO.
    writeYaml(`
version: "1"
commands: not-an-object
`);
    const res = await run({ commandName: "up" });
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: lich up");
  });

  it("long help for help/exec/env includes an Example block", async () => {
    // The three discovery-surface built-ins (introduced in Plan 2) carry
    // long-form help text that must include at least one runnable example
    // so users can copy/paste. Pin that explicitly so future edits to the
    // help text don't accidentally drop the example block.
    for (const name of ["help", "exec", "env"]) {
      stdout = [];
      stderr = [];
      const res = await run({ commandName: name });
      expect(res.exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toMatch(/Examples?:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-command mode — user commands
// ---------------------------------------------------------------------------

describe("runHelp — per-command mode for user commands", () => {
  it("shows the user's help: text verbatim for a user command name", async () => {
    writeYaml(`
version: "1"
commands:
  test:e2e:
    cmd: echo hi
    help: |
      Run e2e tests against the live stack.
      Pass --filter <substring> to narrow the set.
`);
    const res = await run({ commandName: "test:e2e" });
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const out = stdout.join("\n");
    expect(out).toContain("test:e2e");
    expect(out).toContain("Run e2e tests against the live stack.");
    expect(out).toContain("Pass --filter <substring> to narrow the set.");
  });

  it("shows (no help text) for a user command without a help: field", async () => {
    writeYaml(`
version: "1"
commands:
  bare:cmd:
    cmd: echo bare
`);
    const res = await run({ commandName: "bare:cmd" });
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("bare:cmd");
    expect(out).toContain("(no help text)");
    // Should still surface the underlying cmd so the user sees what it runs.
    expect(out).toContain("echo bare");
  });
});

// ---------------------------------------------------------------------------
// Unknown command path
// ---------------------------------------------------------------------------

describe("runHelp — unknown command", () => {
  it("prints 'unknown command' when name matches neither built-in nor user", async () => {
    // No lich.yaml in tmp; "ghost" is not a built-in.
    const res = await run({ commandName: "ghost" });
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown command 'ghost'");
  });

  it("prints 'unknown command' when lich.yaml exists but lacks the name", async () => {
    writeYaml(`
version: "1"
commands:
  real:cmd:
    cmd: echo real
`);
    const res = await run({ commandName: "ghost" });
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown command 'ghost'");
  });

  it("prints 'unknown command' for an unknown name when yaml is malformed", async () => {
    writeYaml(`
version: "1"
commands: nonsense
`);
    const res = await run({ commandName: "ghost" });
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown command 'ghost'");
  });
});
