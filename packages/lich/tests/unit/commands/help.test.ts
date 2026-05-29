import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCommandHelp,
  runGlobalHelp,
} from "../../../src/commands/help.js";

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

async function runGlobal(opts: { cwd?: string } = {}) {
  return runGlobalHelp({
    cwd: opts.cwd ?? tmp,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

async function runCmd(commandName: string, opts: { cwd?: string } = {}) {
  return runCommandHelp({
    commandName,
    cwd: opts.cwd ?? tmp,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

describe("runGlobalHelp", () => {
  it("lists every built-in command with a one-line summary", async () => {
    const res = await runGlobal();
    expect(res.exitCode).toBe(0);

    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");

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
      "exec",
      "env",
    ]) {
      const re = new RegExp(`^  ${name.replace(":", "\\:")}\\b`, "m");
      expect(out).toMatch(re);
    }
  });

  it("does NOT list `help` as a built-in", async () => {
    await runGlobal();
    const out = stdout.join("\n");
    expect(out).not.toMatch(/^  help\b/m);
  });

  it("includes a non-empty summary for each built-in", async () => {
    await runGlobal();
    const upLine = stdout.find((l) => l.match(/^  up\s/));
    expect(upLine).toBeDefined();
    expect(upLine!.replace(/^  up\s+/, "").length).toBeGreaterThan(0);
    const envLine = stdout.find((l) => l.match(/^  env\s/));
    expect(envLine).toBeDefined();
    expect(envLine!.replace(/^  env\s+/, "").length).toBeGreaterThan(0);
  });

  it("prints an intro line and a pointer to per-command help", async () => {
    await runGlobal();
    const out = stdout.join("\n");
    expect(out).toContain("Usage: lich <command>");
    expect(out).toContain("lich <command> --help");
  });

  it("does NOT list user commands when no lich.yaml is present", async () => {
    const res = await runGlobal();
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).not.toContain("User-defined commands");
  });

  it("works in a directory with no lich.yaml (built-ins only)", async () => {
    const res = await runGlobal();
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

    const res = await runGlobal();
    expect(res.exitCode).toBe(0);

    const out = stdout.join("\n");
    expect(out).toContain("Built-in commands:");
    expect(out).toContain("User-defined commands (from lich.yaml):");
    expect(out).toMatch(/^  db:psql\s/m);
    expect(out).toMatch(/^  test:e2e\s/m);

    const e2eLine = stdout.find((l) => l.match(/^  test:e2e\s/));
    expect(e2eLine).toBeDefined();
    expect(e2eLine).toContain("Run e2e tests against the live stack.");
    expect(e2eLine).not.toContain("Multi-line.");

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

    await runGlobal();
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
    await runGlobal();
    const out = stdout.join("\n");
    expect(out).toMatch(/^  bare:cmd\s+\(no help text\)/m);
  });

  it("does NOT crash when lich.yaml is malformed", async () => {
    writeYaml(`
version: "1"
commands: not-an-object-at-all
`);
    const res = await runGlobal();
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
    const res = await runGlobal();
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).not.toContain("User-defined commands");
  });
});

describe("runCommandHelp — built-ins", () => {
  it("shows long help for a built-in command name", async () => {
    const res = await runCmd("up");
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);

    const out = stdout.join("\n");
    expect(out).toContain("Usage: lich up");
    expect(out.split("\n").length).toBeGreaterThan(2);
  });

  it("does NOT load lich.yaml when asking for a built-in without contextual config", async () => {
    writeYaml(`
version: "1"
commands: not-an-object
`);
    const res = await runCmd("down");
    expect(res.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Usage: lich down");
  });

  it("long help for exec/env includes an Example block", async () => {
    for (const name of ["exec", "env"]) {
      stdout = [];
      stderr = [];
      const res = await runCmd(name);
      expect(res.exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const out = stdout.join("\n");
      expect(out).toMatch(/Examples?:/);
    }
  });

  it("lich up --help lists profiles from local lich.yaml when present", async () => {
    writeYaml(`
version: "1"
profiles:
  dev:
    default: true
  prod: {}
`);
    const res = await runCmd("up");
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Usage: lich up");
    expect(out).toContain("Available profiles");
    expect(out).toMatch(/^  dev\b/m);
    expect(out).toMatch(/^  prod\b/m);
    expect(out).toMatch(/dev\s+\(default\)/);
  });

  it("lich up --help omits the profiles block when no yaml is present", async () => {
    const res = await runCmd("up");
    expect(res.exitCode).toBe(0);
    expect(stdout.join("\n")).not.toContain("Available profiles");
  });
});

describe("runCommandHelp — user commands", () => {
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
    const res = await runCmd("test:e2e");
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
    const res = await runCmd("bare:cmd");
    expect(res.exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("bare:cmd");
    expect(out).toContain("(no help text)");
    expect(out).toContain("echo bare");
  });
});

describe("runCommandHelp — unknown command", () => {
  it("prints 'unknown command' when name matches neither built-in nor user", async () => {
    const res = await runCmd("ghost");
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
    const res = await runCmd("ghost");
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown command 'ghost'");
  });

  it("prints 'unknown command' for an unknown name when yaml is malformed", async () => {
    writeYaml(`
version: "1"
commands: nonsense
`);
    const res = await runCmd("ghost");
    expect(res.exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("unknown command 'ghost'");
  });
});
