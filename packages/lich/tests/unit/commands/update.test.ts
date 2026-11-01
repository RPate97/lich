import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  detectInstallPrefix,
  buildInstallEnv,
  buildInstallCommand,
  runUpdate,
} from "../../../src/commands/update.js";

describe("detectInstallPrefix", () => {
  it("returns the two-levels-up prefix for a canonical install path", () => {
    expect(detectInstallPrefix("/Users/x/.local/bin/lich")).toBe("/Users/x/.local");
    expect(detectInstallPrefix("/usr/local/bin/lich")).toBe("/usr/local");
    expect(detectInstallPrefix("/home/user/.local/bin/lich")).toBe("/home/user/.local");
  });

  it("returns null when the path does not look like a bin/lich layout", () => {
    expect(detectInstallPrefix("/Users/x/code/packages/lich/dist/lich")).toBeNull();
    expect(detectInstallPrefix("/opt/weird/binaries/mylich")).toBeNull();
  });
});

describe("buildInstallEnv", () => {
  it("passes neither var when both are default", () => {
    expect(buildInstallEnv({ prefix: null, version: "latest" })).toEqual({});
  });

  it("passes LICH_VERSION when pinning a version", () => {
    expect(buildInstallEnv({ prefix: null, version: "v0.4.0" })).toEqual({
      LICH_VERSION: "v0.4.0",
    });
  });

  it("passes LICH_PREFIX when detected", () => {
    expect(buildInstallEnv({ prefix: "/Users/x/.local", version: "latest" })).toEqual({
      LICH_PREFIX: "/Users/x/.local",
    });
  });

  it("passes both when both apply", () => {
    expect(buildInstallEnv({ prefix: "/opt/lich", version: "v0.4.0" })).toEqual({
      LICH_PREFIX: "/opt/lich",
      LICH_VERSION: "v0.4.0",
    });
  });
});

describe("buildInstallCommand", () => {
  it("is the plain install one-liner when no overrides", () => {
    expect(buildInstallCommand({})).toBe(
      "curl -fsSL https://lich.sh/install.sh | bash",
    );
  });

  it("prepends env assignments before bash", () => {
    expect(
      buildInstallCommand({ LICH_VERSION: "v0.4.0", LICH_PREFIX: "/opt/lich" }),
    ).toBe(
      "curl -fsSL https://lich.sh/install.sh | LICH_PREFIX=/opt/lich LICH_VERSION=v0.4.0 bash",
    );
  });
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-update-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function captureStream(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c) => chunks.push(Buffer.from(c)));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function seedCache(latest: string): void {
  writeFileSync(
    join(home, "latest-check.json"),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      latest_version: latest,
    }),
  );
}

describe("runUpdate --check", () => {
  it("reports out-of-date when cache says current is behind", async () => {
    seedCache("0.6.2");
    const out = captureStream();
    const err = captureStream();

    const r = await runUpdate({
      currentVersion: "0.4.0",
      argv: [],
      check: true,
      dryRun: false,
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      stdout: out.stream,
      stderr: err.stream,
      execPath: "/Users/x/.local/bin/lich",
    });

    expect(r.exitCode).toBe(0);
    expect(out.text()).toContain("current: 0.4.0");
    expect(out.text()).toContain("latest:  0.6.2");
    expect(out.text()).toContain("out of date");
    expect(err.text()).toBe("");
  });

  it("reports up-to-date when current matches cache", async () => {
    seedCache("0.6.2");
    const out = captureStream();

    const r = await runUpdate({
      currentVersion: "0.6.2",
      argv: [],
      check: true,
      dryRun: false,
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      stdout: out.stream,
      stderr: captureStream().stream,
      execPath: "/Users/x/.local/bin/lich",
    });

    expect(r.exitCode).toBe(0);
    expect(out.text()).toContain("up to date");
  });

  it("returns non-zero and prints a hint when the cache is empty and refresh is disabled", async () => {
    const out = captureStream();
    const err = captureStream();

    const r = await runUpdate({
      currentVersion: "0.4.0",
      argv: [],
      check: true,
      dryRun: false,
      env: { LICH_HOME: home, LICH_UPDATE_CHECK_NO_REFRESH: "1" },
      stdout: out.stream,
      stderr: err.stream,
      execPath: "/Users/x/.local/bin/lich",
    });

    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain("could not resolve latest");
  });
});

describe("runUpdate --dry-run", () => {
  it("prints the install one-liner the install would run, with no env when prefix cannot be detected", async () => {
    const out = captureStream();

    const r = await runUpdate({
      currentVersion: "0.4.0",
      argv: [],
      check: false,
      dryRun: true,
      env: { LICH_HOME: home },
      stdout: out.stream,
      stderr: captureStream().stream,
      execPath: "/opt/weird/path/mylich",
    });

    expect(r.exitCode).toBe(0);
    expect(out.text().trim()).toBe(
      "curl -fsSL https://lich.sh/install.sh | bash",
    );
  });

  it("includes LICH_PREFIX when execPath looks canonical", async () => {
    const out = captureStream();

    await runUpdate({
      currentVersion: "0.4.0",
      argv: [],
      check: false,
      dryRun: true,
      env: { LICH_HOME: home },
      stdout: out.stream,
      stderr: captureStream().stream,
      execPath: "/Users/x/.local/bin/lich",
    });

    expect(out.text()).toContain("LICH_PREFIX=/Users/x/.local");
  });

  it("includes LICH_VERSION when a version is pinned via argv", async () => {
    const out = captureStream();

    await runUpdate({
      currentVersion: "0.4.0",
      argv: ["v0.4.0"],
      check: false,
      dryRun: true,
      env: { LICH_HOME: home },
      stdout: out.stream,
      stderr: captureStream().stream,
      execPath: "/opt/weird/path/mylich",
    });

    expect(out.text()).toContain("LICH_VERSION=v0.4.0");
  });
});
