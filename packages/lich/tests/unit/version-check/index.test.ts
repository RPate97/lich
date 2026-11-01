import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runVersionCheck } from "../../../src/version-check/index.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-vc-index-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function captureStderr(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c) => chunks.push(Buffer.from(c)));
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function seedCache(latest: string, checkedAt = new Date().toISOString()): string {
  const path = join(home, "latest-check.json");
  writeFileSync(
    path,
    JSON.stringify({ checked_at: checkedAt, latest_version: latest }),
  );
  return path;
}

describe("runVersionCheck", () => {
  it("emits the notice to stderr when cache says we are behind", () => {
    seedCache("0.6.2");
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.4.0",
      argv: { _: [], json: false, quiet: false, version: false },
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      commandName: "up",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe(
      "lich 0.4.0 is out of date — latest is 0.6.2. Run `lich update` to upgrade.\n",
    );
  });

  it("stays silent when current matches cache", () => {
    seedCache("0.6.2");
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.6.2",
      argv: { _: [], json: false, quiet: false, version: false },
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      commandName: "up",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe("");
  });

  it("stays silent when suppressed (--json)", () => {
    seedCache("0.6.2");
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.4.0",
      argv: { _: [], json: true, quiet: false, version: false },
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      commandName: "stacks",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe("");
  });

  it("stays silent when LICH_NO_UPDATE_CHECK=1", () => {
    seedCache("0.6.2");
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.4.0",
      argv: { _: [], json: false, quiet: false, version: false },
      env: {
        LICH_HOME: home,
        LICH_NO_UPDATE_CHECK: "1",
        LICH_UPDATE_CHECK_NO_REFRESH: "1",
      },
      commandName: "up",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe("");
  });

  it("stays silent when the cache is missing (first run with refresh disabled)", () => {
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.4.0",
      argv: { _: [], json: false, quiet: false, version: false },
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      commandName: "up",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe("");
  });

  it("stays silent when a dev VERSION cannot be compared", () => {
    seedCache("0.6.2");
    const out = captureStderr();

    runVersionCheck({
      currentVersion: "0.0.0-dev",
      argv: { _: [], json: false, quiet: false, version: false },
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      commandName: "up",
      stderr: out.stream,
      nowMs: Date.now(),
    });

    expect(out.text()).toBe("");
  });
});
