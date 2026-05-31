import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogTail } from "../../../src/logs/tail.js";
import { withProgressTimeout } from "../../../src/ready/progress-timeout.js";
import { ReadyTimeoutError } from "../../../src/ready/timeout.js";

let tmpDirs: string[] = [];
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-progress-timeout-"));
  tmpDirs.push(dir);
  return dir;
}

async function startTail(logPath: string, intervalMs = 10): Promise<LogTail> {
  const tail = new LogTail({ logPath, intervalMs });
  tails.push(tail);
  await tail.start();
  return tail;
}

afterEach(async () => {
  for (const tail of tails) {
    try {
      await tail.stop();
    } catch {
      /* ignore */
    }
  }
  tails = [];

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

describe("withProgressTimeout", () => {
  it("resolves when the wrapped promise resolves before any silence deadline", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath);

    const value = await withProgressTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 20)),
      { ms: 500, tail },
    );
    expect(value).toBe("ready");
  });

  it("rejects with ReadyTimeoutError when the log stays silent past the deadline", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath);

    const neverResolves = new Promise<never>(() => {});
    await expect(
      withProgressTimeout(neverResolves, { ms: 80, tail }),
    ).rejects.toBeInstanceOf(ReadyTimeoutError);
  });

  it("ReadyTimeoutError preserves the configured ms and optional phase", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath);

    const neverResolves = new Promise<never>(() => {});
    try {
      await withProgressTimeout(neverResolves, {
        ms: 60,
        tail,
        phase: "log_match",
      });
      throw new Error("expected withProgressTimeout to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadyTimeoutError);
      const e = err as ReadyTimeoutError;
      expect(e.ms).toBe(60);
      expect(e.phase).toBe("log_match");
    }
  });

  it("resets the silence deadline every time a new line is observed", async () => {
    // Heart of the feature. We set a tight ms=80 deadline, then write one
    // log line every 40ms for 5 ticks (~200ms total). Without the reset,
    // we would fail at 80ms; with the reset, every line resets the timer
    // and we comfortably exceed 80ms. After the last write we let the
    // deadline elapse without further activity and expect the timeout.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath, 5);

    const neverResolves = new Promise<never>(() => {});
    const waitPromise = withProgressTimeout(neverResolves, {
      ms: 80,
      tail,
    });

    // Catch the rejection now (avoid unhandled rejection if it fires sooner than expected).
    let rejected = false;
    let rejectedAt = 0;
    const t0 = Date.now();
    const observer = waitPromise.catch(() => {
      rejected = true;
      rejectedAt = Date.now() - t0;
    });

    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 40));
      appendFileSync(logPath, `progress line ${i}\n`);
    }
    // 5 * 40ms = 200ms of activity. With reset, we must not have rejected yet.
    // (Tail poll interval is 5ms so onLine should fire within a few ms of each write.)
    expect(rejected).toBe(false);

    // Now go quiet. The silence deadline (80ms) must fire.
    await observer;
    expect(rejected).toBe(true);
    // It should reject roughly within 80ms after the last write (allow generous slack for CI).
    // Total elapsed since t0 must be > 200ms (the activity window).
    expect(rejectedAt).toBeGreaterThan(200);
  });

  it("propagates the wrapped promise's rejection unchanged", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath);

    const inner = new Error("ready-evaluator failed");
    await expect(
      withProgressTimeout(Promise.reject(inner), { ms: 500, tail }),
    ).rejects.toBe(inner);
  });

  it("does not fire the deadline after the wrapped promise resolves", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath);

    const value = await withProgressTimeout(Promise.resolve("done"), {
      ms: 30,
      tail,
    });
    expect(value).toBe("done");
    // Wait past the deadline; if cleanup didn't fire, an unhandled
    // rejection would scream during this window.
    await new Promise<void>((r) => setTimeout(r, 80));
  });

  it("unsubscribes from the tail after the wrapped promise settles", async () => {
    // Validates cleanup: post-resolution, log lines must not keep the
    // timer alive (subscription leaked → memory leak in long-lived
    // dashboard sessions).
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");
    const tail = await startTail(logPath, 5);

    const subsBefore = (tail as unknown as { subscribers: Set<unknown> })
      .subscribers.size;
    await withProgressTimeout(Promise.resolve(), { ms: 500, tail });
    const subsAfter = (tail as unknown as { subscribers: Set<unknown> })
      .subscribers.size;
    expect(subsAfter).toBe(subsBefore);
  });
});
