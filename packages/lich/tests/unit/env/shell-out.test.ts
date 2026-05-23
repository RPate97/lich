import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnvFromShellOut,
  ShellOutError,
} from "../../../src/env/shell-out.js";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs = [];
});

function makeTmpdir(): string {
  // realpathSync resolves /var → /private/var on macOS so cwd comparisons match.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lich-shellout-")));
  tmpDirs.push(dir);
  return dir;
}

describe("loadEnvFromShellOut", () => {
  it("runs a shorthand string entry and parses dotenv stdout", async () => {
    const result = await loadEnvFromShellOut({
      entries: ['echo "KEY=value"'],
    });
    expect(result).toEqual({ KEY: "value" });
  });

  it("runs a long-form entry with explicit cmd field", async () => {
    const result = await loadEnvFromShellOut({
      entries: [{ cmd: 'echo "KEY=value"' }],
    });
    expect(result).toEqual({ KEY: "value" });
  });

  it("merges multiple entries with later overriding earlier", async () => {
    const result = await loadEnvFromShellOut({
      entries: [
        'printf "A=1\\nB=2\\n"',
        'printf "B=overridden\\nC=3\\n"',
      ],
    });
    expect(result).toEqual({ A: "1", B: "overridden", C: "3" });
  });

  it("parses JSON output and coerces numbers/booleans to strings", async () => {
    const result = await loadEnvFromShellOut({
      entries: [
        { cmd: `echo '{"K":"v","N":42,"B":true}'`, format: "json" },
      ],
    });
    expect(result).toEqual({ K: "v", N: "42", B: "true" });
  });

  it("throws ShellOutError with reason 'parse' when JSON output is nested", async () => {
    let caught: unknown;
    try {
      await loadEnvFromShellOut({
        entries: [
          { cmd: `echo '{"K":{"nested":"obj"}}'`, format: "json" },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShellOutError);
    const err = caught as ShellOutError;
    expect(err.reason).toBe("parse");
    expect(err.cmd).toContain("nested");
  });

  it("throws ShellOutError with reason 'parse' when JSON output is malformed", async () => {
    let caught: unknown;
    try {
      await loadEnvFromShellOut({
        entries: [{ cmd: `echo 'not-json'`, format: "json" }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShellOutError);
    expect((caught as ShellOutError).reason).toBe("parse");
  });

  it("throws ShellOutError with the exit code and stderr detail on non-zero exit", async () => {
    let caught: unknown;
    try {
      await loadEnvFromShellOut({
        entries: ["echo bad >&2; exit 7"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShellOutError);
    const err = caught as ShellOutError;
    expect(err.reason).toBe(7);
    expect(err.detail).toContain("bad");
    expect(err.cmd).toContain("exit 7");
  });

  it("passes baseEnv through to the spawned child", async () => {
    const result = await loadEnvFromShellOut({
      entries: ['echo "X=$MY_VAR"'],
      baseEnv: { PATH: process.env.PATH, MY_VAR: "hello" },
    });
    expect(result).toEqual({ X: "hello" });
  });

  it("honors per-entry cwd", async () => {
    const dir = makeTmpdir();
    const result = await loadEnvFromShellOut({
      entries: [{ cmd: 'echo "C=$(pwd)"', cwd: dir }],
    });
    expect(result).toEqual({ C: dir });
  });

  it("falls back to defaultCwd when entry omits cwd", async () => {
    const dir = makeTmpdir();
    const result = await loadEnvFromShellOut({
      entries: ['echo "C=$(pwd)"'],
      defaultCwd: dir,
    });
    expect(result).toEqual({ C: dir });
  });

  it("returns empty object for empty entries list", async () => {
    const result = await loadEnvFromShellOut({ entries: [] });
    expect(result).toEqual({});
  });

  it("returns empty object when a command succeeds with empty stdout", async () => {
    const result = await loadEnvFromShellOut({ entries: ["true"] });
    expect(result).toEqual({});
  });

  it("parses double-quoted dotenv values with escape sequences", async () => {
    // Use printf to produce: KEY="hello\nworld" literally on stdout, which
    // the dotenv parser then unescapes to a newline.
    const result = await loadEnvFromShellOut({
      entries: [`printf 'KEY="hello\\\\nworld"\\n'`],
    });
    expect(result).toEqual({ KEY: "hello\nworld" });
  });

  it("ignores blank and comment lines and strips 'export ' prefix", async () => {
    const result = await loadEnvFromShellOut({
      entries: [
        `printf '# a comment\\n\\nexport FOO=bar\\nBAZ=qux\\n'`,
      ],
    });
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});
