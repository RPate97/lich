import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guards the shape of version.ts so that if it changes, the release workflow's
// sed pattern is known to need updating too.
describe("version.ts release-workflow sed compatibility", () => {
  const versionFile = resolve(__dirname, "../../src/version.ts");
  const content = readFileSync(versionFile, "utf8");

  it("version.ts contains exactly one VERSION export line", () => {
    const matches = content.match(/^export const VERSION = /gm);
    expect(matches).toHaveLength(1);
  });

  it("release workflow sed pattern replaces VERSION correctly", () => {
    const targetVersion = "1.2.3";
    // Mirrors the sed command in .github/workflows/release.yml. The workflow
    // uses `sed -i.bak ... && rm ...bak` for BSD (macOS) + GNU (Linux) portability;
    // this test verifies the regex semantics only.
    const patched = content.replace(
      /export const VERSION = .*/,
      `export const VERSION = "${targetVersion}";`,
    );
    expect(patched).toBe(`export const VERSION = "${targetVersion}";\n`);
  });

  it("version.ts shape is a single-line quoted string assignment", () => {
    expect(content.trim()).toMatch(/^export const VERSION = "[^"]+";(\s*\/\/.*)?$/);
  });
});
