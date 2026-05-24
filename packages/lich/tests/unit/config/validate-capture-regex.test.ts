/**
 * `lich validate` regex compile-check for `ready_when.capture` (Plan 4
 * Task 13 — LEV-362).
 *
 * The schema (`config/schema.ts`) already locks down the SHAPE of `capture`
 * to a flat `key -> string` map (see `schema-ready-when-capture.test.ts`).
 * This file covers the next layer of safety: `lich validate` walks each
 * capture pattern and tries to compile it with `RegExp(pattern, "u")` so
 * the user finds typos at validate time rather than mysteriously at
 * ready-check time when the extractor compiles the same pattern.
 *
 * These tests drive `runValidate` end-to-end (parse → schema → graph →
 * regex checks → interp checks), same as the existing `log_match` regex
 * coverage in `commands/validate.test.ts`, so a regression in any earlier
 * layer that filters out the `capture` field before `checkRegexes` runs
 * would be caught here, not just at the function level.
 *
 * Live next to the schema-shape tests in `tests/unit/config/` because they
 * share the same surface (`ready_when.capture`) — when a contributor edits
 * either layer the sibling file is one `grep` away.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runValidate } from "../../../src/commands/validate.js";

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-validate-capture-regex-test-"));
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body, "utf8");
  return p;
}

async function run(path: string) {
  return runValidate({
    path,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

describe("runValidate — ready_when.capture regex compile check", () => {
  it("compiles each regex in ready_when.capture and reports compile failures", async () => {
    // `[bad` is an unterminated character class — guaranteed to throw at
    // RegExp() compile time on every JS engine. Mirrors the
    // log_match equivalent in `validate.test.ts`. The validator must exit
    // 1 and surface a `kind: 'regex'` error whose message embeds the bad
    // pattern so the user can grep their yaml for it.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  tunnel:\n    cmd: echo hi\n` +
        `    ready_when:\n` +
        `      log_match: "Listening on"\n` +
        `      capture:\n        url: "[bad"\n`,
    );
    const res = await run(p);
    expect(res.exitCode).toBe(1);
    const rxErr = res.report.errors!.find((e) => e.kind === "regex");
    expect(rxErr).toBeDefined();
    // The bad pattern must appear in the message so the user can identify
    // which capture broke — same UX contract as the log_match check.
    expect(rxErr!.message).toContain("[bad");
  });

  it("accepts a yaml with valid capture regexes", async () => {
    // Happy path: a yaml that mirrors the canonical tunnel-URL use case
    // documented in the spec — two captures, both syntactically valid
    // regexes (one with a group, one without). Validator must exit 0
    // with no errors. Guards against an overzealous future change to
    // `checkRegexes` that would reject legitimate patterns.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  tunnel:\n    cmd: echo hi\n` +
        `    ready_when:\n` +
        `      log_match: "Listening on"\n` +
        `      capture:\n` +
        `        url: "https://[a-z-]+\\\\.trycloudflare\\\\.com"\n` +
        `        port: "Listening on port (\\\\d+)"\n`,
    );
    const res = await run(p);
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
    expect(res.report.errors).toBeUndefined();
  });

  it("locates the error at /owned/<name>/ready_when/capture/<key>", async () => {
    // The error's `location` field is what `lich validate` prints in the
    // pretty output — pinning the exact path-format ensures users can
    // jsonpath-jump to the offending key in their yaml. Mirrors the
    // `${path} (/owned/<name>/ready_when/log_match)` shape used elsewhere
    // in `checkRegexes`.
    const p = writeYaml(
      "lich.yaml",
      `version: "1"\nowned:\n` +
        `  api:\n    cmd: echo hi\n` +
        `    ready_when:\n      capture:\n        token: "(unbalanced"\n`,
    );
    const res = await run(p);
    expect(res.exitCode).toBe(1);
    const rxErr = res.report.errors!.find((e) => e.kind === "regex");
    expect(rxErr).toBeDefined();
    // Exact location format: `<path> (/owned/<name>/ready_when/capture/<key>)`.
    // Substring (not equality) so the absolute tmpdir path doesn't matter.
    expect(rxErr!.location).toContain("/owned/api/ready_when/capture/token");
    expect(rxErr!.location).toContain(p);
  });
});
