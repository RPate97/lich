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
    expect(rxErr!.message).toContain("[bad");
  });

  it("accepts a yaml with valid capture regexes", async () => {
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
    expect(rxErr!.location).toContain("/owned/api/ready_when/capture/token");
    expect(rxErr!.location).toContain(p);
  });
});
