// Separate file from allocator.test.ts because vi.mock("node:child_process") is module-scoped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We mock `node:child_process` so the allocator's docker port probe sees
// a fake `spawnSync` and we can drive the three branches deterministically.
// We re-export the real module's other members because allocator only uses
// `spawnSync`, but other consumers inside the test (none today) shouldn't
// see a half-mocked module.
//
// Bun's test runner doesn't ship `vi.importActual` (vitest-only), so we
// capture the real module via top-level await BEFORE the mock is installed
// and re-export its members alongside the spawnSync spy. We also use Bun's
// native `mock.module(...)` which is what `vi.mock` desugars to under
// `bun test`; calling it directly avoids the missing-`importActual` path.
const spawnSyncSpy = vi.fn();
const realChildProcess =
  await import("node:child_process");
mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawnSync: (...args: unknown[]) => spawnSyncSpy(...args),
}));

import { allocate, release } from "../../../src/ports/allocator.js";

let lichHome: string;
let prevLichHome: string | undefined;

beforeEach(async () => {
  lichHome = await mkdtemp(join(tmpdir(), "lich-alloc-docker-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = lichHome;
  spawnSyncSpy.mockReset();
});

afterEach(async () => {
  if (prevLichHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevLichHome;
  await rm(lichHome, { recursive: true, force: true });
});

// A small high-numbered range nothing is likely to be listening on. We
// pick three consecutive ports so we can have the docker mock claim the
// first one (forcing the allocator to skip to the next).
const RANGE: [number, number] = [54700, 54702];

/**
 * Helper: return a fake `spawnSync` result mimicking what `docker ps`
 * emits with `--format "{{.Ports}}"`. Each port the caller passes
 * appears as a published-mapping line.
 */
function fakeDockerOutput(...mappedPorts: number[]) {
  return {
    pid: 1234,
    status: 0,
    signal: null,
    output: [null, "", ""],
    stdout: mappedPorts
      .map((p) => `0.0.0.0:${p}->5432/tcp, [::]:${p}->5432/tcp`)
      .join("\n"),
    stderr: "",
  };
}

describe("isPortFree (LEV-478): docker container port awareness", () => {
  it("skips a port that docker reports as published, even when Node bind succeeds", async () => {
    // The mocked docker holds the first port of the range. Lich must
    // skip it and allocate something higher.
    const blockedPort = RANGE[0];
    spawnSyncSpy.mockImplementation(() => fakeDockerOutput(blockedPort));

    const result = await allocate({
      stackId: "docker-blocked",
      logicalPorts: { svc: null },
      range: RANGE,
    });

    expect(result.svc).not.toBe(blockedPort);
    expect(result.svc).toBeGreaterThanOrEqual(RANGE[0]);
    expect(result.svc).toBeLessThanOrEqual(RANGE[1]);
    // Sanity check: the docker probe actually ran. We probed at least
    // the first port (which our mock said was held) before moving on.
    expect(spawnSyncSpy).toHaveBeenCalled();
    const firstCallArgs = spawnSyncSpy.mock.calls[0];
    expect(firstCallArgs[0]).toBe("docker");
    expect(firstCallArgs[1]).toEqual(["ps", "-a", "--format", "{{.Ports}}"]);

    await release("docker-blocked");
  });

  it("when docker reports no matching mapping, allocation proceeds normally", async () => {
    // Docker has containers running, but none on our range. Allocator
    // should hand out the lowest-free port (the start of the range).
    spawnSyncSpy.mockImplementation(() =>
      // unrelated mapping at port 19999
      fakeDockerOutput(19999),
    );

    const result = await allocate({
      stackId: "docker-irrelevant",
      logicalPorts: { svc: null },
      range: RANGE,
    });

    expect(result.svc).toBe(RANGE[0]);
    expect(spawnSyncSpy).toHaveBeenCalled();

    await release("docker-irrelevant");
  });

  it("falls back to Node-only behavior when docker exits nonzero (daemon down)", async () => {
    // Simulate `docker ps` failing — non-zero exit, possibly with stderr
    // like "Cannot connect to the Docker daemon". We must not pretend
    // ports are held when we can't actually check.
    spawnSyncSpy.mockImplementation(() => ({
      pid: 1234,
      status: 1,
      signal: null,
      output: [null, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"],
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    }));

    const result = await allocate({
      stackId: "docker-down",
      logicalPorts: { svc: null },
      range: RANGE,
    });

    // Node probe says everything in the range is free, so we get the
    // lowest port. No false rejection from the failed docker probe.
    expect(result.svc).toBe(RANGE[0]);

    await release("docker-down");
  });

  it("falls back to Node-only behavior when spawnSync throws (docker binary missing)", async () => {
    // On some platforms `spawnSync` for a missing binary throws ENOENT
    // rather than returning a result with status !== 0. Catch and fall
    // back the same way as the nonzero-status case.
    spawnSyncSpy.mockImplementation(() => {
      const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await allocate({
      stackId: "docker-missing",
      logicalPorts: { svc: null },
      range: RANGE,
    });

    expect(result.svc).toBe(RANGE[0]);

    await release("docker-missing");
  });
});
