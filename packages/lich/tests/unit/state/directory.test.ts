import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureStackDir,
  envDir,
  listStacks,
  logsDir,
  removeStackDir,
  serviceEnvPath,
  serviceLogPath,
  stackDir,
  stateRoot,
} from "../../../src/state/directory.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-test-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("stateRoot", () => {
  it("uses $LICH_HOME/stacks when LICH_HOME is set", () => {
    expect(stateRoot()).toBe(join(home, "stacks"));
  });

  it("falls back to ~/.lich/stacks when LICH_HOME is unset", () => {
    delete process.env.LICH_HOME;
    const root = stateRoot();
    expect(root.endsWith(join(".lich", "stacks"))).toBe(true);
    // Should not be inside our test tmpdir
    expect(root.startsWith(home)).toBe(false);
  });

  it("falls back to ~/.lich/stacks when LICH_HOME is empty string", () => {
    process.env.LICH_HOME = "";
    const root = stateRoot();
    expect(root.endsWith(join(".lich", "stacks"))).toBe(true);
  });
});

describe("path helpers", () => {
  it("stackDir is <stateRoot>/<id>", () => {
    expect(stackDir("abc123")).toBe(join(home, "stacks", "abc123"));
  });

  it("logsDir is <stackDir>/logs", () => {
    expect(logsDir("abc123")).toBe(join(home, "stacks", "abc123", "logs"));
  });

  it("envDir is <stackDir>/env", () => {
    expect(envDir("abc123")).toBe(join(home, "stacks", "abc123", "env"));
  });

  it("serviceLogPath is <logsDir>/<service>.log", () => {
    expect(serviceLogPath("abc123", "api")).toBe(
      join(home, "stacks", "abc123", "logs", "api.log"),
    );
  });

  it("serviceEnvPath is <envDir>/<service>.env", () => {
    expect(serviceEnvPath("abc123", "api")).toBe(
      join(home, "stacks", "abc123", "env", "api.env"),
    );
  });
});

describe("ensureStackDir", () => {
  it("creates the stack directory and its logs/ and env/ subdirs", async () => {
    await ensureStackDir("s1");
    expect(statSync(stackDir("s1")).isDirectory()).toBe(true);
    expect(statSync(logsDir("s1")).isDirectory()).toBe(true);
    expect(statSync(envDir("s1")).isDirectory()).toBe(true);
  });

  it("is idempotent on an already-existing layout", async () => {
    await ensureStackDir("s1");
    await ensureStackDir("s1");
    expect(statSync(stackDir("s1")).isDirectory()).toBe(true);
  });

  it("creates parent directories implicitly when stateRoot does not yet exist", async () => {
    // LICH_HOME exists but no `stacks/` underneath it yet.
    await ensureStackDir("brand-new");
    expect(statSync(logsDir("brand-new")).isDirectory()).toBe(true);
  });
});

describe("removeStackDir", () => {
  it("removes the stack directory and its contents", async () => {
    await ensureStackDir("s1");
    writeFileSync(join(stackDir("s1"), "state.json"), "{}");
    writeFileSync(serviceLogPath("s1", "api"), "log");
    await removeStackDir("s1");
    expect(() => statSync(stackDir("s1"))).toThrow();
  });

  it("is idempotent — succeeds when the directory does not exist", async () => {
    await expect(removeStackDir("never-existed")).resolves.toBeUndefined();
  });
});

describe("listStacks", () => {
  it("returns [] when stateRoot does not exist", async () => {
    expect(await listStacks()).toEqual([]);
  });

  it("returns directory names under stateRoot", async () => {
    await ensureStackDir("alpha");
    await ensureStackDir("bravo");
    await ensureStackDir("charlie");
    expect(await listStacks()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("skips non-directory entries in stateRoot", async () => {
    await ensureStackDir("alpha");
    // Drop a stray file under <stateRoot> (e.g..DS_Store).
    mkdirSync(join(home, "stacks"), { recursive: true });
    writeFileSync(join(home, "stacks", ".DS_Store"), "junk");
    expect(await listStacks()).toEqual(["alpha"]);
  });
});
