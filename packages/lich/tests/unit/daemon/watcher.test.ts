import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateWatcher } from "../../../src/daemon/watcher.js";

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
 * Poll until predicate(value) is true or timeout — avoids picking a fixed
 * setTimeout value that's either flaky or wasteful.
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After start() resolves, chokidar's 'ready' has fired but macOS under
 * heavy load can drop the very first event. 50ms cushion is empirically reliable.
 */
async function startAndSettle(w: StateWatcher): Promise<void> {
  await w.start();
  await sleep(50);
}

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

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");

    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBe(1);
  });

  it("fires onChange when a file in a subdirectory changes", async () => {
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

describe("StateWatcher — debouncing", () => {
  it("coalesces multiple rapid file events into a single onChange call", async () => {
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
    for (let i = 0; i < 5; i++) {
      writeFileSync(stateFile, `{"iteration":${i}}\n`, "utf8");
    }

    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    await sleep(150); // beyond a second debounce window
    expect(callCount).toBe(1);
  });

  it("fires once per debounce window, not per event", async () => {
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

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await sleep(250);
    expect(callCount).toBe(0);

    watcher = null;
  });

  it("cancels a pending debounce timer when stopped", async () => {
    // stop() must cancel pending callbacks — otherwise they fire after teardown
    let callCount = 0;
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 250,
      onChange: () => {
        callCount++;
      },
    });
    await startAndSettle(watcher);

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await sleep(50);
    await watcher.stop();

    await sleep(400);
    expect(callCount).toBe(0);

    watcher = null;
  });
});

describe("StateWatcher — idempotence", () => {
  it("start() called twice does not double-fire onChange", async () => {
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
    await sleep(50);

    writeFileSync(join(stateRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
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
    await expect(watcher.stop()).resolves.toBeUndefined();

    watcher = null;
  });

  it("stop() called before start() does not throw", async () => {
    watcher = new StateWatcher({
      stateRoot,
      debounceMs: 100,
      onChange: () => {},
    });

    await expect(watcher.stop()).resolves.toBeUndefined();

    watcher = null;
  });
});

describe("StateWatcher — missing stateRoot tolerance", () => {
  it("does not throw when stateRoot does not exist at start", async () => {
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
    await sleep(50);

    writeFileSync(join(missingRoot, "state.json"), '{"status":"up"}\n', "utf8");
    await waitFor(
      () => callCount,
      (n) => n >= 1,
    );
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("handles a stateRoot whose parent also doesn't exist", async () => {
    const deepMissing = join(stateRoot, "never", "existed");

    watcher = new StateWatcher({
      stateRoot: deepMissing,
      debounceMs: 100,
      onChange: () => {},
    });

    await expect(watcher.start()).resolves.toBeUndefined();

    expect(() =>
      writeFileSync(join(deepMissing, "marker"), "ok", "utf8"),
    ).not.toThrow();
  });
});

describe("StateWatcher — error isolation", () => {
  it("continues firing onChange even when a prior callback threw", async () => {
    // touch two different files — chokidar same-file heuristics vary by platform
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

describe("StateWatcher — directory events", () => {
  it("fires onChange when a new stack subdirectory appears", async () => {
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
