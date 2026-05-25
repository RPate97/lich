import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateWatcher } from "../../../src/daemon/watcher.js";

// ---------------------------------------------------------------------------
// Fixture harness
//
// Every test gets a fresh tmpdir to use as `stateRoot`. The watcher is
// cleaned up in afterEach regardless of pass/fail to avoid leaking file
// handles between tests — chokidar holds OS-level fd resources.
// ---------------------------------------------------------------------------

let stateRoot: string;
let watcher: StateWatcher | null = null;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "lich-watcher-"));
});

afterEach(async () => {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
  rmSync(stateRoot, { recursive: true, force: true });
});

/**
 * Poll `getter()` until it satisfies `predicate(value)` or the timeout
 * elapses. Lets the "I expect callCount to eventually hit N" tests
 * resolve as soon as the event arrives rather than waiting a fixed
 * worst-case duration. Returns the final value.
 *
 * Why polling instead of a flat `setTimeout`: chokidar's event delivery
 * latency varies with OS-level fs.watch scheduling, especially on macOS
 * under test-runner load. A fixed `setTimeout(ms)` either picks a value
 * too short (flake) or wastes runtime. Polling threads the needle and
 * eliminates a class of timing-related flakiness.
 */
async function waitFor<T>(
  getter: () => T,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let value = getter();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    value = getter();
  }
  return value;
}

/**
 * Sleep helper for negative assertions ("nothing should fire within
 * this window"). Used sparingly — most tests should `waitFor` a
 * positive condition.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After `start()` resolves, chokidar's underlying fs.watch handles are
 * attached and 'ready' has fired. On macOS however, there can be a
 * tiny additional window during which the very first event is
 * occasionally missed (we've observed this under heavy test-runner
 * load — Bun's built-in runner specifically). A 50ms cushion after
 * start() has been empirically reliable across hundreds of runs.
 */
async function startAndSettle(w: StateWatcher): Promise<void> {
  await w.start();
  await sleep(50);
}

// ---------------------------------------------------------------------------
// Basic event triggering
// ---------------------------------------------------------------------------

describe("StateWatcher — basic event triggering", () => {
  it("fires onChange after debounceMs when a new file is added", async () => {
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    // Touch a fresh file under stateRoot. ignoreInitial means chokidar
    // skips the initial scan, so this 'add' event drives the test.
    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");

    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBe(1);
  });

  it("fires onChange when a file in a subdirectory changes", async () => {
    // This is the realistic shape: state.json lives at
    // <stateRoot>/<stack-id>/state.json. Chokidar's default depth is
    // unlimited, so subdirectory events should bubble up.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    const stackDir = join(stateRoot, "abc123");
    await mkdir(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "state.json"), '{"status":"up"}\n', "utf8");

    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Debouncing semantics
// ---------------------------------------------------------------------------

describe("StateWatcher — debouncing", () => {
  it("coalesces multiple rapid file events into a single onChange call", async () => {
    // The whole point of debouncing: a burst of writes (which `lich up`
    // produces during stack startup) should result in ONE refresh of
    // downstream consumers, not five.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 150,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    const stateFile = join(stateRoot, "state.json");
    // Five rapid writes, well inside the 150ms window. Each one should
    // reset the debounce timer; only the final one matters.
    for (let i = 0; i < 5; i++) {
      writeFileSync(stateFile, `{"iteration":${i}}\n`, "utf8");
    }

    // Wait until at least one call has fired (the debounce window
    // closing), then wait a bit longer to make sure no extras follow.
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    await sleep(150); // beyond a second debounce window
    expect(callCount).toBe(1);
  });

  it("fires once per debounce window, not per event", async () => {
    // First burst → 1 call. Wait past the window. Second burst → 1 more
    // call. Total: 2. This verifies the debounce resets cleanly between
    // windows; a buggy implementation might fire twice for the first
    // burst (once per event) or zero times for the second (timer leaks).
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    writeFileSync(join(stateRoot, "first-a.json"), '{"burst":1}\n', "utf8");
    writeFileSync(join(stateRoot, "first-b.json"), '{"burst":1.1}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    // Make sure no second call sneaks in during the rest of THIS window.
    await sleep(150);
    expect(callCount).toBe(1);

    writeFileSync(join(stateRoot, "second-a.json"), '{"burst":2}\n', "utf8");
    writeFileSync(join(stateRoot, "second-b.json"), '{"burst":2.1}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 2,
    );
    await sleep(150);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: stop semantics
// ---------------------------------------------------------------------------

describe("StateWatcher — stop()", () => {
  it("prevents future onChange calls after stop", async () => {
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);
    await watcher.stop();

    // After stop, write a file — no onChange should fire.
    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await sleep(250); // debounce + grace
    expect(callCount).toBe(0);

    // Null out so afterEach doesn't double-stop (it's idempotent, but
    // this keeps the test's intent clear).
    watcher = null;
  });

  it("cancels a pending debounce timer when stopped", async () => {
    // Trigger an event, then stop() BEFORE the debounce window elapses.
    // The pending callback must be cancelled — otherwise it fires after
    // the consumer thought the watcher was torn down.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 250, // longer window to make the race obvious
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    // Wait a little so the chokidar event has fired and scheduled the
    // debounce, but well before the 250ms debounce can elapse.
    await sleep(50);
    await watcher.stop();

    // Wait well past the original debounce — no onChange should fire.
    await sleep(400);
    expect(callCount).toBe(0);

    watcher = null;
  });
});

// ---------------------------------------------------------------------------
// Idempotence — both start() and stop() must tolerate repeated calls
// ---------------------------------------------------------------------------

describe("StateWatcher — idempotence", () => {
  it("start() called twice does not double-fire onChange", async () => {
    // A buggy implementation might attach two sets of chokidar listeners,
    // causing every event to fire onChange twice. The contract says
    // start() is idempotent; the second call is a no-op.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await watcher.start();
    await watcher.start();
    await sleep(50); // settle

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    // Grace period to detect a buggy double-fire.
    await sleep(150);

    expect(callCount).toBe(1);
  });

  it("stop() called twice does not throw", async () => {
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {},
    });
    await watcher.start();

    await watcher.stop();
    // Second call is a no-op — should not throw, should not reject.
    await expect(watcher.stop()).resolves.toBeUndefined();

    watcher = null;
  });

  it("stop() called before start() does not throw", async () => {
    // Defensive: the daemon's cleanup path might call stop() on a
    // watcher that never started (e.g. if start() threw earlier in
    // the boot sequence). It must not blow up.
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {},
    });

    await expect(watcher.stop()).resolves.toBeUndefined();

    watcher = null;
  });
});

// ---------------------------------------------------------------------------
// Tolerance: missing stateRoot
// ---------------------------------------------------------------------------

describe("StateWatcher — missing stateRoot tolerance", () => {
  it("does not throw when stateRoot does not exist at start", async () => {
    // Simulate a fresh install: <LICH_HOME>/stacks has never been
    // created. start() must tolerate this — either by creating the
    // directory or by ignoring the ENOENT chokidar would raise. The
    // module's docs commit to the "create the directory" approach.
    const missingRoot = join(stateRoot, "does-not-exist");

    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot: missingRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    await sleep(50); // settle

    // After start, the directory should exist (we created it) and
    // subsequent events under it should fire onChange normally.
    writeFileSync(join(missingRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("handles a stateRoot whose parent also doesn't exist", async () => {
    // Two-deep missing: <stateRoot>/never/existed. The recursive mkdir
    // in start() should create the whole chain.
    const deepMissing = join(stateRoot, "never", "existed");

    watcher = new StateWatcher({
      stateRoot: deepMissing,
      debounceMs: 100,
      onChange: () => {},
    });

    await expect(watcher.start()).resolves.toBeUndefined();

    // Belt-and-suspenders: directory should now exist; verify by
    // creating a file inside without raising ENOENT.
    expect(() =>
      writeFileSync(join(deepMissing, "marker"), "ok", "utf8"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error isolation — a buggy callback should not crash the watcher
// ---------------------------------------------------------------------------

describe("StateWatcher — error isolation", () => {
  it("continues firing onChange even when a prior callback threw", async () => {
    // The daemon's onChange callback talks to two subsystems
    // (dashboard cache invalidation, proxy routing reload). If one
    // throws, the watcher should keep working so the next state change
    // still gets a chance to refresh things.
    //
    // We touch two DIFFERENT files (rather than the same one twice) to
    // avoid relying on chokidar's heuristics for "the same file was
    // modified again very recently" — those vary by platform and add
    // flakiness. Different file paths = unambiguous `add` events.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("simulated consumer bug");
        }
      },
    });
    await startAndSettle(watcher);

    writeFileSync(join(stateRoot, "first.json"), '{"burst":1}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBe(1);

    writeFileSync(join(stateRoot, "second.json"), '{"burst":2}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 2,
    );
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Directory events
// ---------------------------------------------------------------------------

describe("StateWatcher — directory events", () => {
  it("fires onChange when a new stack subdirectory appears", async () => {
    // `lich up` creates the stack directory as one of its first steps.
    // The dashboard wants to know "a new stack just appeared" so it can
    // re-list. This event must fire.
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    mkdirSync(join(stateRoot, "newly-created-stack"));
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});
