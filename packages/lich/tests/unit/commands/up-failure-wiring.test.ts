import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import {
  readSnapshot,
  type StackSnapshot,
} from "../../../src/state/snapshot.js";
import { release } from "../../../src/ports/allocator.js";
import { LogTail } from "../../../src/logs/tail.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-fw-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

async function loadSnapshot(stackId: string): Promise<StackSnapshot> {
  const snap = await readSnapshot(stackId);
  if (!snap) throw new Error(`no snapshot for ${stackId}`);
  return snap;
}

describe("up wiring — failure snapshot fields", () => {
  it("populates snap.failure_reason and snap.failure_log_tail when a service fails", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19500, 19550]
owned:
  broken:
    cmd: 'echo "starting up"; echo "about to crash"; sleep 0.5; exit 1'
    ready_when:
      log_match: "READY"
      timeout: "10s"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    const snap = await loadSnapshot(result.stackId!);
    const brokenSvc = snap.services.find((s) => s.name === "broken");
    expect(brokenSvc?.state).toBe("failed");

    expect(brokenSvc?.failure_reason).toBeDefined();
    expect(typeof brokenSvc?.failure_reason).toBe("string");
    expect(brokenSvc?.failure_reason!.length).toBeGreaterThan(0);

    expect(Array.isArray(brokenSvc?.failure_log_tail)).toBe(true);
    const joined = (brokenSvc?.failure_log_tail ?? []).join("\n");
    expect(joined).toMatch(/starting up|about to crash/);
  }, 15_000);
});

describe("up wiring — capture context flow", () => {
  it("threads captured values from one service into the next service's env", async () => {
    const sentinel = join(projectDir, "consumer.out");
    writeYaml(`
version: "1"
runtime:
  port_range: [19560, 19610]
owned:
  producer:
    cmd: 'echo "Listening on http://localhost:8765"; echo "READY"; sleep 30'
    ready_when:
      log_match: "READY"
      capture:
        url: "http://localhost:\\\\d+"
  consumer:
    cmd: 'printf %s "$CAPTURED_URL" > ${sentinel}; echo "READY"; sleep 30'
    depends_on: [producer]
    env:
      CAPTURED_URL: "\${owned.producer.captured.url}"
    ready_when:
      log_match: "READY"
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(0);

    const sentinelContent = readFileSync(sentinel, "utf8");
    expect(sentinelContent).toBe("http://localhost:8765");
  }, 20_000);
});

describe("up wiring — fail_when vs ready_when race", () => {
  it("races fail_when against ready_when and surfaces fail_when's reason when it fires first", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19620, 19670]
owned:
  loud:
    cmd: 'echo "EADDRINUSE somewhere"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "30s"
    fail_when:
      log_match: "EADDRINUSE"
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // failure must arrive well before the 30s ready timeout
    expect(elapsed).toBeLessThan(10_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "loud");
    expect(svc?.state).toBe("failed");

    expect(svc?.failure_reason).toContain("EADDRINUSE");
  }, 15_000);
});

describe("up wiring — LogTail cleanup", () => {
  it("stops all LogTails when up is cancelled mid-startup", async () => {
    // indirect: a leaked LogTail's 100ms poll would keep the event loop
    // alive past the per-test timeout
    writeYaml(`
version: "1"
runtime:
  port_range: [19680, 19730]
owned:
  hanging:
    cmd: 'sleep 60'
    ready_when:
      log_match: "READY"
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);

    const { stream } = captureStdout();
    const startedAt = Date.now();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    // 8s budget: 250ms abort delay + handle.stop()'s SIGTERM→SIGKILL grace.
    // A leaked LogTail would pin the event loop past the per-test timeout.
    expect(elapsed).toBeLessThan(8_000);
  }, 10_000);

  it("stops all LogTails on the catch-all error path", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19740, 19790]
owned:
  doomed:
    cmd: 'echo "EADDRINUSE somewhere"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "30s"
    fail_when:
      log_match: "EADDRINUSE"
`);

    // prototype spy catches every LogTail constructed during runUp
    const startSpy = vi.spyOn(LogTail.prototype, "start");
    const stopSpy = vi.spyOn(LogTail.prototype, "stop");
    try {
      const { stream } = captureStdout();
      const result = await runUp({
        cwd: projectDir,
        outputMode: "json",
        out: stream,
      });
      if (result.stackId) createdStackIds.push(result.stackId);

      expect(result.exitCode).toBe(1);

      expect(startSpy.mock.calls.length).toBeGreaterThan(0);

      // stop >= start because stop is idempotent and may be called per-level
      // and via the catch-all and via AbortSignal — pin "no started tail
      // left untouched"
      expect(stopSpy.mock.calls.length).toBeGreaterThanOrEqual(
        startSpy.mock.calls.length,
      );
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
    }
  }, 15_000);

  it("leaves LogTails running on successful up — Map isn't cleared", async () => {
    // happy-path tails stay running so post-startup fail_when stays armed.
    // assert via "no .stop() called between runUp entry and successful return"
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  ready_fast:
    cmd: 'echo "READY"; sleep 60'
    ready_when:
      log_match: "READY"
      timeout: "10s"
`);

    const startSpy = vi.spyOn(LogTail.prototype, "start");
    const stopSpy = vi.spyOn(LogTail.prototype, "stop");
    let result: Awaited<ReturnType<typeof runUp>> | undefined;
    try {
      const { stream } = captureStdout();
      result = await runUp({
        cwd: projectDir,
        outputMode: "json",
        out: stream,
      });
      if (result.stackId) createdStackIds.push(result.stackId);

      expect(result.exitCode).toBe(0);

      expect(startSpy.mock.calls.length).toBeGreaterThan(0);

      expect(stopSpy.mock.calls.length).toBe(0);
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      // explicit kill of the long-lived child — afterEach only releases ports
      if (result?.stackId) {
        try {
          const snap = await readSnapshot(result.stackId);
          for (const svc of snap?.services ?? []) {
            if (typeof svc.pid === "number") {
              try {
                process.kill(svc.pid, "SIGTERM");
              } catch {
                // already dead / not ours — harmless
              }
            }
          }
        } catch {
          // snapshot read failed — nothing to clean up that we can find
        }
      }
    }
  }, 15_000);
});

describe("up wiring — post-ready exit detection", () => {
  it("fails immediately on a service that exits before becoming ready", async () => {
    // NO ready_when — load-bearing: detection budget is checkExitedNow's ~100ms
    writeYaml(`
version: "1"
runtime:
  port_range: [19740, 19790]
owned:
  exiter:
    cmd: 'exit 1'
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    expect(elapsed).toBeLessThan(5_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "exiter");
    expect(svc?.state).toBe("failed");
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
  }, 10_000);

  it("fails the up when a service exits after ready but before up returns", async () => {
    // service READY → exits 200ms later; after_ready sleeps 1s. Without
    // the post-ready watcher we'd mark ready and exit success.
    const marker = join(projectDir, "after-ready-marker.txt");
    writeYaml(`
version: "1"
runtime:
  port_range: [19800, 19850]
owned:
  crasher:
    cmd: 'echo "READY"; sleep 0.2; exit 1'
    ready_when:
      log_match: "READY"
    lifecycle:
      after_ready:
        - cmd: 'sleep 1; touch ${marker}'
`);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "crasher");
    expect(svc?.state).toBe("failed");
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
  }, 10_000);

  it("does not hang on ready_when after the process has died", async () => {
    // 30s ready timeout but exit-watcher must surface failure well under that
    writeYaml(`
version: "1"
runtime:
  port_range: [19860, 19910]
owned:
  dead-on-arrival:
    cmd: 'exit 1'
    ready_when:
      http_get: '/health'
      timeout: '30s'
    port:
      published_env: PORT
`);

    const start = Date.now();
    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    const elapsed = Date.now() - start;
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode).toBe(1);
    expect(elapsed).toBeLessThan(10_000);

    const snap = await loadSnapshot(result.stackId!);
    const svc = snap.services.find((s) => s.name === "dead-on-arrival");
    expect(svc?.state).toBe("failed");
    // exit must win the race; not a ready timeout
    expect(svc?.failure_reason).toBeDefined();
    expect(svc?.failure_reason!.toLowerCase()).toMatch(/exit|exited/);
    expect(svc?.failure_reason!.toLowerCase()).not.toMatch(/timeout/);
  }, 15_000);
});
