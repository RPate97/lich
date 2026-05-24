import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTail } from "../../../src/logs/tail.js";

// Plan 4 Task 1 — skeleton tests. The poll loop and event emission land in
// Task 2; AbortSignal-driven shutdown in Task 3. These tests verify the API
// shape and the idempotency contract that the rest of Plan 4 will lean on.

// Track tmpdirs per test so afterEach can tear them all down.
let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-logtail-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

describe("LogTail (skeleton)", () => {
  it("constructs without throwing for a path that doesn't exist yet", () => {
    // The supervisor opens the log file lazily; consumers will often
    // construct the LogTail before any bytes have been written. The
    // skeleton must not stat or open the path at construction time.
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet-created.log");
    expect(() => new LogTail({ logPath })).not.toThrow();
  });

  it("start() resolves and stop() is idempotent", async () => {
    // Verifies the lifecycle contract: start can be awaited, stop can be
    // awaited, and either may be called multiple times without side effects.
    // The Task 2 poll-loop implementation will hang its scheduling and
    // teardown logic off the same flags this test exercises.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const tail = new LogTail({ logPath, intervalMs: 25 });

    await expect(tail.start()).resolves.toBeUndefined();
    // Second start is a no-op (idempotent).
    await expect(tail.start()).resolves.toBeUndefined();

    await expect(tail.stop()).resolves.toBeUndefined();
    // Second stop is a no-op (idempotent).
    await expect(tail.stop()).resolves.toBeUndefined();

    // start() after stop() is a no-op — once stopped, a LogTail is dead.
    // Consumers that want to "restart" tailing should construct fresh.
    await expect(tail.start()).resolves.toBeUndefined();
  });

  it("stop() is safe to call before start()", async () => {
    // Defensive shutdown path: if `up.ts` aborts mid-construction, every
    // LogTail in its registry gets a `.stop()` call regardless of whether
    // it ever reached `.start()`. The skeleton must tolerate that.
    const dir = makeTmpDir();
    const tail = new LogTail({ logPath: join(dir, "svc.log") });
    await expect(tail.stop()).resolves.toBeUndefined();
  });

  it("onLine() returns an unsubscribe function that is safe to call multiple times", () => {
    // The unsubscribe is a closure over `Set.delete`. We document that
    // repeat calls are no-ops so downstream callers (e.g. `fail_when`'s
    // sentinel race) can call it from both their success and failure
    // paths without needing a "did I already unsubscribe?" flag.
    const dir = makeTmpDir();
    const tail = new LogTail({ logPath: join(dir, "svc.log") });

    const noop = (): void => {
      /* skeleton: never invoked */
    };
    const unsub = tail.onLine(noop);
    expect(typeof unsub).toBe("function");

    // Multiple calls are safe.
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  it("onLine() can register multiple distinct subscribers", () => {
    // Plan 4's whole reason for existing is fan-out: ready_when, fail_when,
    // capture, and the dashboard all subscribe to the same tail. The
    // skeleton accepts multiple subscribers and returns independent
    // unsubscribe handles for each.
    const dir = makeTmpDir();
    const tail = new LogTail({ logPath: join(dir, "svc.log") });

    const subs: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      subs.push(
        tail.onLine(() => {
          /* skeleton: never invoked */
        }),
      );
    }

    // Each unsubscribe is distinct and independently callable.
    for (const u of subs) {
      expect(typeof u).toBe("function");
      expect(() => u()).not.toThrow();
    }
  });

  it("buffer getter returns an empty string in the skeleton", () => {
    // Documents the Task 1 placeholder behavior. Task 2 will replace this
    // with a real accumulator. Asserting "" here makes the test break
    // (intentionally) once Task 2's buffer wiring lands, prompting the
    // implementer to update the test to match the new contract.
    const dir = makeTmpDir();
    const tail = new LogTail({ logPath: join(dir, "svc.log") });
    expect(tail.buffer).toBe("");
  });

  it("accepts an AbortSignal option without observing it (wired in Task 3)", () => {
    // The option is accepted from day one so downstream tasks can wire
    // their orchestrator code against the final API. The skeleton ignores
    // the signal; Task 3 will attach the abort listener.
    const dir = makeTmpDir();
    const ac = new AbortController();
    const tail = new LogTail({
      logPath: join(dir, "svc.log"),
      signal: ac.signal,
    });
    // Aborting the signal does NOT throw and does NOT impact the API
    // shape — until Task 3 wires it, abort is a silent no-op.
    expect(() => ac.abort()).not.toThrow();
    expect(typeof tail.onLine(() => {})).toBe("function");
  });
});
