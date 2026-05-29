import { describe, it, expect, afterEach } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTail } from "../../../src/logs/tail.js";

let tmpDirs: string[] = [];
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-logtail-"));
  tmpDirs.push(dir);
  return dir;
}

function makeTail(
  opts: ConstructorParameters<typeof LogTail>[0],
): LogTail {
  const tail = new LogTail(opts);
  tails.push(tail);
  return tail;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const tail of tails) {
    try {
      await tail.stop();
    } catch {
      // ignore
    }
  }
  tails = [];

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
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet-created.log");
    expect(() => makeTail({ logPath })).not.toThrow();
  });

  it("start() resolves and stop() is idempotent", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const tail = makeTail({ logPath, intervalMs: 25 });

    await expect(tail.start()).resolves.toBeUndefined();
    await expect(tail.start()).resolves.toBeUndefined();

    await expect(tail.stop()).resolves.toBeUndefined();
    await expect(tail.stop()).resolves.toBeUndefined();

    // start() after stop() is a no-op — stopped LogTail is permanent
    await expect(tail.start()).resolves.toBeUndefined();
  });

  it("stop() is safe to call before start()", async () => {
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });
    await expect(tail.stop()).resolves.toBeUndefined();
  });

  it("onLine() returns an unsubscribe function that is safe to call multiple times", () => {
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });

    const noop = (): void => {
      /* skeleton: never invoked */
    };
    const unsub = tail.onLine(noop);
    expect(typeof unsub).toBe("function");

    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  it("onLine() can register multiple distinct subscribers", () => {
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });

    const subs: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      subs.push(
        tail.onLine(() => {
          /* skeleton: never invoked */
        }),
      );
    }

    for (const u of subs) {
      expect(typeof u).toBe("function");
      expect(() => u()).not.toThrow();
    }
  });

  it("accepts an AbortSignal option without throwing on abort", () => {
    const dir = makeTmpDir();
    const ac = new AbortController();
    const tail = makeTail({
      logPath: join(dir, "svc.log"),
      signal: ac.signal,
    });
    expect(() => ac.abort()).not.toThrow();
    expect(typeof tail.onLine(() => {})).toBe("function");
  });
});

describe("LogTail (poll loop)", () => {
  it("emits each line to a single subscriber as the file grows", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "first line\n");
    appendFileSync(logPath, "second line\n");
    appendFileSync(logPath, "third line\n");

    await waitFor(() => received.length >= 3);
    expect(received).toEqual(["first line", "second line", "third line"]);
  });

  it("emits each line to multiple subscribers (fan-out)", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const recvA: string[] = [];
    const recvB: string[] = [];
    tail.onLine((line) => recvA.push(line));
    tail.onLine((line) => recvB.push(line));
    await tail.start();

    appendFileSync(logPath, "alpha\nbeta\n");

    await waitFor(() => recvA.length >= 2 && recvB.length >= 2);
    expect(recvA).toEqual(["alpha", "beta"]);
    expect(recvB).toEqual(["alpha", "beta"]);
  });

  it("does not re-emit lines that were already read before subscribing", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    await tail.start();

    appendFileSync(logPath, "early-one\nearly-two\n");
    await waitFor(() => tail.buffer.includes("early-two"));

    const received: string[] = [];
    tail.onLine((line) => received.push(line));

    await sleep(40);
    expect(received).toEqual([]);

    appendFileSync(logPath, "late-one\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["late-one"]);
  });

  it("carries a trailing partial line across ticks", async () => {
    // subscribers see complete lines only — partial chunk held in pending across ticks
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "hello");

    await sleep(50);
    expect(received).toEqual([]);

    appendFileSync(logPath, " world\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["hello world"]);
  });

  it("buffer getter returns the full accumulated content", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    await tail.start();

    appendFileSync(logPath, "line-a\nline-b\npartial");

    await waitFor(() => tail.buffer.includes("partial"));
    expect(tail.buffer).toBe("line-a\nline-b\npartial");
  });

  it("buffer getter is empty before start() has read anything", () => {
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });
    expect(tail.buffer).toBe("");
  });

  it("stop() halts emission even if a poll is in flight", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "before-stop\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["before-stop"]);

    await tail.stop();
    appendFileSync(logPath, "after-stop-1\nafter-stop-2\n");

    await sleep(80);
    expect(received).toEqual(["before-stop"]);
  });

  it("survives the log file not existing at start()", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet.log");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    await sleep(40);
    expect(received).toEqual([]);

    writeFileSync(logPath, "post-creation\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["post-creation"]);
  });

  it("handles file truncation gracefully", async () => {
    // policy: don't re-read after truncation; wait for file to grow back past offset
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "pre-trunc-1\npre-trunc-2\n");
    await waitFor(() => received.length >= 2);
    expect(received).toEqual(["pre-trunc-1", "pre-trunc-2"]);

    truncateSync(logPath, 0);
    await sleep(40);
    expect(received).toEqual(["pre-trunc-1", "pre-trunc-2"]);

    // grow past prior offset so resume path fires
    const padding = "x".repeat(200) + "\nresume-line\n";
    appendFileSync(logPath, padding);

    await waitFor(() => received.some((l) => l === "resume-line"), {
      timeoutMs: 2000,
    });
    expect(received).toContain("resume-line");
  });

  it("delivers lines to all surviving subscribers if one unsubscribes mid-emission", async () => {
    // emission loop snapshots subscribers before iterating — removal during tick is safe
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const recvA: string[] = [];
    const recvB: string[] = [];
    let unsubA: (() => void) | null = null;
    unsubA = tail.onLine((line) => {
      recvA.push(line);
      if (line === "first") unsubA?.();
    });
    tail.onLine((line) => recvB.push(line));
    await tail.start();

    appendFileSync(logPath, "first\n");
    await waitFor(() => recvB.length >= 1);
    expect(recvA).toEqual(["first"]);
    expect(recvB).toEqual(["first"]);

    appendFileSync(logPath, "second\n");
    await waitFor(() => recvB.length >= 2);
    expect(recvA).toEqual(["first"]);
    expect(recvB).toEqual(["first", "second"]);
  });

  it("a throwing subscriber does not block other subscribers", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const recvB: string[] = [];
    tail.onLine(() => {
      throw new Error("oops");
    });
    tail.onLine((line) => recvB.push(line));
    await tail.start();

    appendFileSync(logPath, "only-line\n");
    await waitFor(() => recvB.length >= 1);
    expect(recvB).toEqual(["only-line"]);
  });
});

describe("LogTail (AbortSignal shutdown)", () => {
  it("auto-stops when the provided AbortSignal fires", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    const tail = makeTail({
      logPath,
      intervalMs: 10,
      signal: ac.signal,
    });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "pre-abort\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["pre-abort"]);

    ac.abort();

    await sleep(5);

    appendFileSync(logPath, "post-abort-1\npost-abort-2\n");

    await sleep(80);
    expect(received).toEqual(["pre-abort"]);
  });

  it("treats an already-aborted signal at construction as a born-stopped tail", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    ac.abort();
    const tail = makeTail({
      logPath,
      intervalMs: 10,
      signal: ac.signal,
    });

    const received: string[] = [];
    tail.onLine((line) => received.push(line));

    await tail.start();

    appendFileSync(logPath, "never-emitted-1\nnever-emitted-2\n");

    await sleep(80);
    expect(received).toEqual([]);
  });

  it("start() after the signal fires is a no-op (no restart)", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    const tail = makeTail({
      logPath,
      intervalMs: 10,
      signal: ac.signal,
    });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));

    ac.abort();
    await sleep(5);

    await tail.start();

    appendFileSync(logPath, "never-emitted\n");

    await sleep(80);
    expect(received).toEqual([]);
  });

  it("abort during a poll cycle does not deliver any further lines", async () => {
    // stopped flag set synchronously from abort handler — any tick boundary after abort respects it
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    const tail = makeTail({
      logPath,
      intervalMs: 10,
      signal: ac.signal,
    });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "line-1\nline-2\nline-3\n");
    ac.abort();

    await sleep(80);

    appendFileSync(logPath, "after-cutoff-1\nafter-cutoff-2\n");

    await sleep(80);
    expect(received).not.toContain("after-cutoff-1");
    expect(received).not.toContain("after-cutoff-2");
  });

  it("stop() called explicitly removes the abort listener so the signal can be GC'd cleanly", async () => {
    // leak guard: stop() must removeEventListener so retained closures don't accumulate
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    // wrap with Reflect.apply to avoid depending on DOM lib types
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: unknown[]) => {
      if (args[0] === "abort") addCount += 1;
      return Reflect.apply(realAdd, ac.signal, args);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((...args: unknown[]) => {
      if (args[0] === "abort") removeCount += 1;
      return Reflect.apply(realRemove, ac.signal, args);
    }) as typeof ac.signal.removeEventListener;

    const tail = makeTail({
      logPath,
      intervalMs: 10,
      signal: ac.signal,
    });
    expect(addCount).toBe(1);
    expect(removeCount).toBe(0);

    await tail.start();
    await tail.stop();

    expect(removeCount).toBe(1);
  });
});

describe("LogTail (startOffset)", () => {
  it("skips prior-run content when startOffset equals file size at spawn", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const priorContent = "prior-run-line-1\nprior-run-line-2\n";
    writeFileSync(logPath, priorContent);
    const offset = Buffer.byteLength(priorContent);

    const tail = makeTail({ logPath, intervalMs: 10, startOffset: offset });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    await sleep(40);
    expect(received).toEqual([]);
    expect(tail.buffer).toBe("");

    appendFileSync(logPath, "new-run-line\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["new-run-line"]);
    expect(tail.buffer).toBe("new-run-line\n");
  });

  it("buffer excludes prior-run bytes so fail_when retroactive sweep sees only new content", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const stale = "STALE_SENTINEL\n";
    writeFileSync(logPath, stale);
    const offset = Buffer.byteLength(stale);

    const tail = makeTail({ logPath, intervalMs: 10, startOffset: offset });
    await tail.start();

    appendFileSync(logPath, "clean-startup\n");
    await waitFor(() => tail.buffer.includes("clean-startup"));

    expect(tail.buffer).not.toContain("STALE_SENTINEL");
    expect(tail.buffer).toContain("clean-startup");
  });

  it("startOffset of 0 behaves identically to omitting startOffset", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "existing-line\n");

    const tail = makeTail({ logPath, intervalMs: 10, startOffset: 0 });
    await tail.start();

    await waitFor(() => tail.buffer.includes("existing-line"));
    expect(tail.buffer).toContain("existing-line");
  });
});
