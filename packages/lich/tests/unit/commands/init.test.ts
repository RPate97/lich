import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  hasGitignoreEntry,
  runInit,
  runInitSync,
  SKELETON_YAML,
} from "../../../src/commands/init.js";
import { parseConfig } from "../../../src/config/parse.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lich-init-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function read(name: string): string {
  return readFileSync(path.join(tmp, name), "utf8");
}

function exists(name: string): boolean {
  return existsSync(path.join(tmp, name));
}

function write(name: string, contents: string): void {
  writeFileSync(path.join(tmp, name), contents, "utf8");
}

// ---------------------------------------------------------------------------
// Empty directory — happy path
// ---------------------------------------------------------------------------

describe("runInitSync — empty directory", () => {
  it("writes lich.yaml AND .gitignore with .lich/; exit 0", () => {
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    // lich.yaml present and matches the skeleton.
    expect(exists("lich.yaml")).toBe(true);
    expect(read("lich.yaml")).toBe(SKELETON_YAML);

    // .gitignore created with the .lich/ entry.
    expect(exists(".gitignore")).toBe(true);
    expect(read(".gitignore")).toContain(".lich/");

    // Messages reflect both writes and end with the next-steps hint.
    const joined = result.messages.join("\n");
    expect(joined).toContain("wrote lich.yaml");
    expect(joined).toContain(".lich/");
    expect(joined).toContain("lich validate");
  });
});

// ---------------------------------------------------------------------------
// Existing lich.yaml behavior
// ---------------------------------------------------------------------------

describe("runInitSync — existing lich.yaml", () => {
  it("without --force: refuses to overwrite, exit non-zero, message mentions 'already exists'", () => {
    const original = "version: 'preexisting'\n";
    write("lich.yaml", original);

    const result = runInitSync({}, tmp);

    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join("\n").toLowerCase()).toContain("already exists");
    // Original file is untouched.
    expect(read("lich.yaml")).toBe(original);
    // No .gitignore should be created when we bailed out.
    expect(exists(".gitignore")).toBe(false);
  });

  it("with --force: overwrites with the skeleton, exit 0", () => {
    write("lich.yaml", "version: 'preexisting'\n");

    const result = runInitSync({ force: true }, tmp);

    expect(result.exitCode).toBe(0);
    expect(read("lich.yaml")).toBe(SKELETON_YAML);
    // Output should communicate the overwrite happened.
    expect(result.messages.join("\n")).toMatch(/overwrote|overwrite|wrote/i);
  });
});

// ---------------------------------------------------------------------------
// .gitignore behavior
// ---------------------------------------------------------------------------

describe("runInitSync — .gitignore handling", () => {
  it("appends .lich/ to an existing .gitignore without it; preserves prior contents", () => {
    const prior = "node_modules/\n.env\ndist/\n";
    write(".gitignore", prior);

    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const after = read(".gitignore");
    // All original lines preserved.
    expect(after).toContain("node_modules/");
    expect(after).toContain(".env");
    expect(after).toContain("dist/");
    // New entry appended.
    expect(after).toContain(".lich/");
    // Only ONE occurrence of the entry as a standalone line.
    const lines = after.split(/\r?\n/).filter((l) => l.trim() === ".lich/");
    expect(lines.length).toBe(1);
  });

  it("appends .lich/ even when the existing file lacks a trailing newline", () => {
    write(".gitignore", "node_modules/"); // no trailing newline
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const after = read(".gitignore");
    expect(after).toContain("node_modules/");
    expect(after).toContain(".lich/");
    // Both entries on their own lines.
    const lines = after.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".lich/");
  });

  it("leaves an existing .gitignore alone if .lich/ already appears", () => {
    const prior = "node_modules/\n.lich/\ndist/\n";
    write(".gitignore", prior);

    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    // File is byte-identical — no duplicate, no whitespace fiddling.
    expect(read(".gitignore")).toBe(prior);
    // Output does NOT claim we appended anything.
    expect(result.messages.join("\n")).not.toMatch(/added \.lich\/ to \.gitignore/);
  });

  it("ignores .lich/ entries that are commented out and appends a real one", () => {
    write(".gitignore", "# .lich/\nnode_modules/\n");
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const lines = read(".gitignore")
      .split(/\r?\n/)
      .map((l) => l.trim());
    // The comment is preserved; a new real entry is added.
    expect(lines).toContain("# .lich/");
    expect(lines).toContain(".lich/");
  });

  it("--no-gitignore: writes lich.yaml but does NOT touch .gitignore", () => {
    const result = runInitSync({ noGitignore: true }, tmp);
    expect(result.exitCode).toBe(0);
    expect(exists("lich.yaml")).toBe(true);
    expect(exists(".gitignore")).toBe(false);
  });

  it("--no-gitignore: leaves a pre-existing .gitignore unchanged", () => {
    const prior = "node_modules/\n";
    write(".gitignore", prior);

    const result = runInitSync({ noGitignore: true }, tmp);
    expect(result.exitCode).toBe(0);
    expect(read(".gitignore")).toBe(prior);
  });
});

// ---------------------------------------------------------------------------
// Skeleton validity — the file `lich init` produces must pass schema.
// ---------------------------------------------------------------------------

describe("runInitSync — skeleton is a valid lich.yaml", () => {
  it("written lich.yaml parses + passes schema validation", async () => {
    runInitSync({}, tmp);

    const result = await parseConfig(path.join(tmp, "lich.yaml"));
    if (!result.ok) {
      // Surface the errors for debugging if validation ever regresses.
      const dump = result.errors.map((e) => `${e.kind}: ${e.message}`).join("\n");
      throw new Error(`skeleton failed to validate:\n${dump}`);
    }
    expect(result.ok).toBe(true);
    expect(result.config.version).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Async wrapper — sanity check that runInit() resolves with the same code.
// ---------------------------------------------------------------------------

describe("runInit (async wrapper)", () => {
  it("resolves 0 on a clean tmpdir", async () => {
    const code = await runInit({}, tmp);
    expect(code).toBe(0);
    expect(exists("lich.yaml")).toBe(true);
  });

  it("resolves non-zero when lich.yaml exists and --force is not set", async () => {
    write("lich.yaml", "version: 'x'\n");
    const code = await runInit({}, tmp);
    expect(code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hasGitignoreEntry — pure helper, unit-tested directly so other consumers
// can rely on its semantics.
// ---------------------------------------------------------------------------

describe("hasGitignoreEntry", () => {
  it("matches a bare line", () => {
    expect(hasGitignoreEntry(".lich/\n", ".lich/")).toBe(true);
  });

  it("matches with surrounding whitespace", () => {
    expect(hasGitignoreEntry("  .lich/  \n", ".lich/")).toBe(true);
  });

  it("does not match commented lines", () => {
    expect(hasGitignoreEntry("# .lich/\n", ".lich/")).toBe(false);
  });

  it("does not match a different pattern", () => {
    expect(hasGitignoreEntry(".lich\n", ".lich/")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(hasGitignoreEntry("", ".lich/")).toBe(false);
  });
});
