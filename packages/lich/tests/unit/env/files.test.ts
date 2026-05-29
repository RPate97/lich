import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadEnvFiles } from "../../../src/env/files.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lich-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const p = path.join(tmp, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

function missing(name: string): string {
  return path.join(tmp, name);
}

describe("loadEnvFiles — empty / missing inputs", () => {
  it("returns {} for empty input array", async () => {
    const env = await loadEnvFiles({ files: [] });
    expect(env).toEqual({});
  });

  it("silently skips a single missing file and returns {}", async () => {
    const env = await loadEnvFiles({ files: [missing(".env")] });
    expect(env).toEqual({});
  });

  it("skips every missing file across a list of misses", async () => {
    const env = await loadEnvFiles({
      files: [missing(".env"), missing(".env.local"), missing(".env.test")],
    });
    expect(env).toEqual({});
  });
});

describe("loadEnvFiles — single file basics", () => {
  it("loads simple KEY=value lines", async () => {
    const f = write(".env", "FOO=bar\nBAZ=qux\nNUM=42\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ FOO: "bar", BAZ: "qux", NUM: "42" });
  });

  it("ignores blank lines and `#` comment lines", async () => {
    const f = write(
      ".env",
      [
        "# top comment",
        "",
        "FOO=bar",
        "   ",
        "# another comment",
        "BAZ=qux",
        "",
      ].join("\n"),
    );
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips a leading `export ` prefix", async () => {
    const f = write(".env", "export FOO=bar\nexport BAZ=qux\nPLAIN=ok\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ FOO: "bar", BAZ: "qux", PLAIN: "ok" });
  });

  it("trims trailing whitespace on unquoted values", async () => {
    const f = write(".env", "FOO=bar   \nBAZ=qux\t\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("treats an empty value as an empty string", async () => {
    const f = write(".env", "EMPTY=\nFOO=bar\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ EMPTY: "", FOO: "bar" });
  });

  it("does NOT strip inline `# comment` after an unquoted value", async () => {
    // dotenv-conventional: inline # is NOT a comment; becomes part of value
    const f = write(".env", "FOO=bar # not a comment\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({ FOO: "bar # not a comment" });
  });
});

describe("loadEnvFiles — quoted values", () => {
  it("strips outer double quotes and preserves spaces", async () => {
    const f = write(".env", 'GREETING="hello world"\nKEY="value with spaces"\n');
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({
      GREETING: "hello world",
      KEY: "value with spaces",
    });
  });

  it("processes \\n \\t \\\\ \\\" escapes inside double quotes", async () => {
    const f = write(
      ".env",
      'NL="line1\\nline2"\nTB="a\\tb"\nBS="back\\\\slash"\nQT="say \\"hi\\""\n',
    );
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({
      NL: "line1\nline2",
      TB: "a\tb",
      BS: "back\\slash",
      QT: 'say "hi"',
    });
  });

  it("strips outer single quotes and treats contents as literal", async () => {
    const f = write(".env", "LITERAL='no \\n escapes here'\nSPACES='a b c'\n");
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({
      LITERAL: "no \\n escapes here",
      SPACES: "a b c",
    });
  });

  it("allows a `#` inside a quoted value (not a comment)", async () => {
    const f = write(".env", 'HASH="has # inside"\nSQ=\'also # inside\'\n');
    const env = await loadEnvFiles({ files: [f] });
    expect(env).toEqual({
      HASH: "has # inside",
      SQ: "also # inside",
    });
  });
});

describe("loadEnvFiles — merging across multiple files", () => {
  it("merges keys from multiple files when there is no collision", async () => {
    const a = write("a.env", "FROM_A=1\n");
    const b = write("b.env", "FROM_B=2\n");
    const env = await loadEnvFiles({ files: [a, b] });
    expect(env).toEqual({ FROM_A: "1", FROM_B: "2" });
  });

  it("lets a later file override an earlier file on collision", async () => {
    const a = write("a.env", "SHARED=from_a\nONLY_A=1\n");
    const b = write("b.env", "SHARED=from_b\nONLY_B=2\n");
    const env = await loadEnvFiles({ files: [a, b] });
    expect(env).toEqual({
      SHARED: "from_b",
      ONLY_A: "1",
      ONLY_B: "2",
    });
  });

  it("loads present files and skips missing files in the same list", async () => {
    const a = write("a.env", "FROM_A=1\n");
    const b = write("c.env", "FROM_C=3\n");
    const env = await loadEnvFiles({
      files: [a, missing("b.env"), b],
    });
    expect(env).toEqual({ FROM_A: "1", FROM_C: "3" });
  });

  it("respects declared order across 3 files (last wins per key)", async () => {
    const a = write("a.env", "K=a\n");
    const b = write("b.env", "K=b\n");
    const c = write("c.env", "K=c\n");
    const env = await loadEnvFiles({ files: [a, b, c] });
    expect(env).toEqual({ K: "c" });
  });
});

describe("loadEnvFiles — parse errors", () => {
  it("throws on an unbalanced double quote, with file and line number", async () => {
    const f = write(".env", 'GOOD=ok\nBAD="oops\n');
    await expect(loadEnvFiles({ files: [f] })).rejects.toThrow(
      new RegExp(`${escapeRegex(f)}:2:.*unbalanced double quote`),
    );
  });

  it("throws on an unbalanced single quote, with file and line number", async () => {
    const f = write(".env", "OK=1\nBAD='unclosed\n");
    await expect(loadEnvFiles({ files: [f] })).rejects.toThrow(
      new RegExp(`${escapeRegex(f)}:2:.*unbalanced single quote`),
    );
  });

  it("throws on a line that has no `=`", async () => {
    const f = write(".env", "OK=1\nNOEQUALS\n");
    await expect(loadEnvFiles({ files: [f] })).rejects.toThrow(
      new RegExp(`${escapeRegex(f)}:2:.*missing '='`),
    );
  });

  it("throws on an empty key (`=value`)", async () => {
    const f = write(".env", "=value\n");
    await expect(loadEnvFiles({ files: [f] })).rejects.toThrow(
      new RegExp(`${escapeRegex(f)}:1:.*empty key`),
    );
  });

  it("error message is prefixed with `env_files:`", async () => {
    const f = write(".env", 'BAD="oops\n');
    await expect(loadEnvFiles({ files: [f] })).rejects.toThrow(/^env_files:/);
  });
});

describe("loadEnvFiles — read errors other than ENOENT", () => {
  it("throws with the file path in the message for non-ENOENT read errors", async () => {
    // EISDIR is not ENOENT — loader must surface, not silently skip
    const dirPath = path.join(tmp, "a-directory");
    await fsp.mkdir(dirPath);
    await expect(loadEnvFiles({ files: [dirPath] })).rejects.toThrow(
      new RegExp(`env_files: failed to read ${escapeRegex(dirPath)}`),
    );
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
