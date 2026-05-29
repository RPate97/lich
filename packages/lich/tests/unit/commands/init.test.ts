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

describe("runInitSync — empty directory", () => {
  it("writes lich.yaml AND .gitignore with .lich/; exit 0", () => {
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    expect(exists("lich.yaml")).toBe(true);
    expect(read("lich.yaml")).toBe(SKELETON_YAML);

    expect(exists(".gitignore")).toBe(true);
    expect(read(".gitignore")).toContain(".lich/");

    const joined = result.messages.join("\n");
    expect(joined).toContain("wrote lich.yaml");
    expect(joined).toContain(".lich/");
    expect(joined).toContain("lich validate");
  });
});

describe("runInitSync — existing lich.yaml", () => {
  it("without --force: refuses to overwrite, exit non-zero, message mentions 'already exists'", () => {
    const original = "version: 'preexisting'\n";
    write("lich.yaml", original);

    const result = runInitSync({}, tmp);

    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join("\n").toLowerCase()).toContain("already exists");
    expect(read("lich.yaml")).toBe(original);
    expect(exists(".gitignore")).toBe(false);
  });

  it("with --force: overwrites with the skeleton, exit 0", () => {
    write("lich.yaml", "version: 'preexisting'\n");

    const result = runInitSync({ force: true }, tmp);

    expect(result.exitCode).toBe(0);
    expect(read("lich.yaml")).toBe(SKELETON_YAML);
    expect(result.messages.join("\n")).toMatch(/overwrote|overwrite|wrote/i);
  });
});

describe("runInitSync — .gitignore handling", () => {
  it("appends .lich/ to an existing .gitignore without it; preserves prior contents", () => {
    const prior = "node_modules/\n.env\ndist/\n";
    write(".gitignore", prior);

    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const after = read(".gitignore");
    expect(after).toContain("node_modules/");
    expect(after).toContain(".env");
    expect(after).toContain("dist/");
    expect(after).toContain(".lich/");
    const lines = after.split(/\r?\n/).filter((l) => l.trim() === ".lich/");
    expect(lines.length).toBe(1);
  });

  it("appends .lich/ even when the existing file lacks a trailing newline", () => {
    write(".gitignore", "node_modules/");
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const after = read(".gitignore");
    expect(after).toContain("node_modules/");
    expect(after).toContain(".lich/");
    const lines = after.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".lich/");
  });

  it("leaves an existing .gitignore alone if .lich/ already appears", () => {
    const prior = "node_modules/\n.lich/\ndist/\n";
    write(".gitignore", prior);

    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    expect(read(".gitignore")).toBe(prior);
    expect(result.messages.join("\n")).not.toMatch(/added \.lich\/ to \.gitignore/);
  });

  it("ignores .lich/ entries that are commented out and appends a real one", () => {
    write(".gitignore", "# .lich/\nnode_modules/\n");
    const result = runInitSync({}, tmp);
    expect(result.exitCode).toBe(0);

    const lines = read(".gitignore")
      .split(/\r?\n/)
      .map((l) => l.trim());
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

describe("runInitSync — skeleton is a valid lich.yaml", () => {
  it("written lich.yaml parses + passes schema validation", async () => {
    runInitSync({}, tmp);

    const result = await parseConfig(path.join(tmp, "lich.yaml"));
    if (!result.ok) {
      const dump = result.errors.map((e) => `${e.kind}: ${e.message}`).join("\n");
      throw new Error(`skeleton failed to validate:\n${dump}`);
    }
    expect(result.ok).toBe(true);
    expect(result.config.version).toBe("1");
  });

  it("advertises the live GitHub raw URL for yaml-language-server", () => {
    runInitSync({}, tmp);
    const contents = read("lich.yaml");
    const firstLine = contents.split("\n", 1)[0];
    expect(firstLine).toBe(
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/RPate97/lich/main/packages/lich/schema/v1.json"
    );
    // exactly ONE active $schema= directive — guards against reverts to the
    // dead lich.sh URL referenced later in the comment block
    const directives = contents.match(/\$schema=/g) ?? [];
    expect(directives.length).toBe(1);
  });
});

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
