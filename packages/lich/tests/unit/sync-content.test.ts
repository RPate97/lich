import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandIncludes } from "../../scripts/sync-content";

describe("expandIncludes", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sync-content-test-"));
    mkdirSync(join(tmp, "_generated"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns content unchanged when no include directives", () => {
    const sourceFile = join(tmp, "spec.md");
    expect(expandIncludes("hello\nworld\n", sourceFile)).toBe("hello\nworld\n");
  });

  it("expands a full-file include", () => {
    writeFileSync(join(tmp, "_generated", "snippet.md"), "snippet body\n");
    const sourceFile = join(tmp, "spec.md");
    const input = "before\n<!-- @include: ./_generated/snippet.md -->\nafter\n";
    expect(expandIncludes(input, sourceFile)).toBe("before\nsnippet body\n\nafter\n");
  });

  it("expands a section include by anchor slug", () => {
    writeFileSync(
      join(tmp, "_generated", "snippet.md"),
      "# Intro\n\nignored\n\n## Services\n\nrow1\nrow2\n\n## Owned\n\nrow3\n",
    );
    const sourceFile = join(tmp, "spec.md");
    const input = "<!-- @include: ./_generated/snippet.md#services -->";
    expect(expandIncludes(input, sourceFile)).toBe("row1\nrow2");
  });

  it("throws when include file is missing", () => {
    const sourceFile = join(tmp, "spec.md");
    expect(() =>
      expandIncludes("<!-- @include: ./_generated/missing.md -->", sourceFile),
    ).toThrow(/Include not found/);
  });

  it("throws when section anchor is not found", () => {
    writeFileSync(join(tmp, "_generated", "snippet.md"), "# only-heading\n\nbody\n");
    const sourceFile = join(tmp, "spec.md");
    expect(() =>
      expandIncludes("<!-- @include: ./_generated/snippet.md#nope -->", sourceFile),
    ).toThrow(/Section #nope not found/);
  });
});
