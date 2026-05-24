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

// Plan 4 Task 1 — skeleton + Task 2 — poll loop + line emission.
//
// Task 1 tests verify the API shape and idempotency. Task 2 tests verify
// the runtime behavior: poll cadence, line splitting, fan-out, retroactive
// buffer accumulator, stop-mid-poll cleanliness, file-not-yet-existing
// tolerance, and truncation safety.
//
// AbortSignal-driven shutdown is Task 3 (separate test scope).

// Track tmpdirs per test so afterEach can tear them all down.
let tmpDirs: string[] = [];
// Track LogTails per test so afterEach can stop them even when an
// assertion blew up partway through.
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-logtail-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Construct a LogTail tracked for afterEach cleanup. Tests should call
 * this rather than `new LogTail(...)` directly so a thrown assertion
 * doesn't leak a running interval.
 */
function makeTail(
  opts: ConstructorParameters<typeof LogTail>[0],
): LogTail {
  const tail = new LogTail(opts);
  tails.push(tail);
  return tail;
}

/**
 * Wait `ms` milliseconds. Used to give the poll loop time to tick.
 * Tests use small values (typically 2-5x `intervalMs`) and the LogTail
 * is constructed with `intervalMs: 10` to keep total runtime tight.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll a predicate until it returns true or the timeout elapses. Faster
 * than fixed sleeps and more reliable than waiting on a single tick.
 * Throws if the deadline passes — tests should not call this without
 * expecting the condition to come true.
 */
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
  // Stop every tail first so we don't leak polling intervals across tests.
  // Stopping is idempotent and safe even on tails that never started.
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
    // The supervisor opens the log file lazily; consumers will often
    // construct the LogTail before any bytes have been written. The
    // skeleton must not stat or open the path at construction time.
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet-created.log");
    expect(() => makeTail({ logPath })).not.toThrow();
  });

  it("start() resolves and stop() is idempotent", async () => {
    // Verifies the lifecycle contract: start can be awaited, stop can be
    // awaited, and either may be called multiple times without side effects.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    const tail = makeTail({ logPath, intervalMs: 25 });

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
    const tail = makeTail({ logPath: join(dir, "svc.log") });
    await expect(tail.stop()).resolves.toBeUndefined();
  });

  it("onLine() returns an unsubscribe function that is safe to call multiple times", () => {
    // The unsubscribe is a closure over `Set.delete`. We document that
    // repeat calls are no-ops so downstream callers (e.g. `fail_when`'s
    // sentinel race) can call it from both their success and failure
    // paths without needing a "did I already unsubscribe?" flag.
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });

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
    const tail = makeTail({ logPath: join(dir, "svc.log") });

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

  it("accepts an AbortSignal option without throwing on abort", () => {
    // Smoke test for the AbortSignal API surface. The richer behavioral
    // assertions live in the "AbortSignal" describe block below; this
    // skeleton-level test just verifies that:
    //   - the constructor accepts a signal option
    //   - calling abort() doesn't throw synchronously from the constructor's
    //     wiring path
    //   - the LogTail's `onLine()` registration shape stays intact through
    //     an abort (subscribers can register on a post-abort LogTail; they
    //     just never fire because the poll loop never runs)
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
    // The core happy path: write lines to the file, the poll loop reads
    // them, the subscriber receives each one. This is the contract every
    // other Plan 4 watcher (ready_when.log_match, fail_when, dashboard)
    // is built on, so verifying it directly is load-bearing.
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
    // The whole reason LogTail exists: read one file, deliver to N
    // consumers. Plan 4 wires up to four subscribers per service in
    // pathological cases (ready, fail_when, dashboard, plus any user
    // tooling). This test verifies the fan-out path with two; more would
    // be more of the same code path.
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
    // Subscribe-order matters. A subscriber that registers AFTER the loop
    // has already read content does not see those earlier lines — the
    // `buffer` getter is the retrospective surface. This contract is what
    // lets capture (Task 6) and live-tail (Plan 5) layer onto the same
    // LogTail without each owning replay state.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    await tail.start();

    // Seed some content BEFORE any subscriber registers.
    appendFileSync(logPath, "early-one\nearly-two\n");
    await waitFor(() => tail.buffer.includes("early-two"));

    // Now subscribe. The early lines must NOT be replayed.
    const received: string[] = [];
    tail.onLine((line) => received.push(line));

    // Wait a few ticks to confirm no replay happens (no event fires).
    await sleep(40);
    expect(received).toEqual([]);

    // New content arriving AFTER subscription should still fire.
    appendFileSync(logPath, "late-one\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["late-one"]);
  });

  it("carries a trailing partial line across ticks", async () => {
    // Subscribers see complete lines only. A chunk that arrives without
    // a terminating newline is held in `pending` until the next tick
    // delivers the rest. Without this, every poll-boundary mid-line
    // would emit a half-line and corrupt downstream matchers.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    // First chunk: no newline. The poll loop must NOT emit yet.
    appendFileSync(logPath, "hello");

    // Give the loop a few ticks. If we emit eagerly, we'd see "hello"
    // here, which would break the contract.
    await sleep(50);
    expect(received).toEqual([]);

    // Second chunk: closes the line. Now the subscriber sees "hello world"
    // as a single complete line.
    appendFileSync(logPath, " world\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["hello world"]);
  });

  it("buffer getter returns the full accumulated content", async () => {
    // Retrospective surface for capture. Every byte read since start()
    // is preserved in the buffer, regardless of subscriber state. The
    // buffer is what capture (Task 6) runs its regex against.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    await tail.start();

    appendFileSync(logPath, "line-a\nline-b\npartial");

    await waitFor(() => tail.buffer.includes("partial"));
    // Byte-for-byte: includes the partial trailing chunk too — because
    // capture wants to match against the raw stream, not line-split.
    expect(tail.buffer).toBe("line-a\nline-b\npartial");
  });

  it("buffer getter is empty before start() has read anything", () => {
    // Documents that the buffer is initially empty. The skeleton's "" is
    // preserved as the initial state of the poll-loop implementation.
    const dir = makeTmpDir();
    const tail = makeTail({ logPath: join(dir, "svc.log") });
    expect(tail.buffer).toBe("");
  });

  it("stop() halts emission even if a poll is in flight", async () => {
    // The stop contract: once stop() returns, no further lines emit even
    // if a tick was already mid-I/O. We exercise this by writing content
    // (queueing up a tick of work) and immediately calling stop(). The
    // test is timing-sensitive but the poll loop's stop-check after I/O
    // makes this deterministic in practice.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    appendFileSync(logPath, "before-stop\n");
    // Allow one tick to land that line.
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["before-stop"]);

    // Now stop and write more. The new content must NOT be emitted.
    await tail.stop();
    appendFileSync(logPath, "after-stop-1\nafter-stop-2\n");

    // Wait longer than several intervalMs cycles to confirm no emission.
    await sleep(80);
    expect(received).toEqual(["before-stop"]);
  });

  it("survives the log file not existing at start()", async () => {
    // The common case: the orchestrator constructs and start()s the
    // LogTail before the supervisor has spawned the service. The poll
    // loop silently keeps polling until the file appears, then picks
    // up reading from offset 0.
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet.log");
    // Deliberately do NOT create the file.

    const tail = makeTail({ logPath, intervalMs: 10 });
    const received: string[] = [];
    tail.onLine((line) => received.push(line));
    await tail.start();

    // Confirm nothing crashes during the silent polling phase.
    await sleep(40);
    expect(received).toEqual([]);

    // File appears late.
    writeFileSync(logPath, "post-creation\n");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["post-creation"]);
  });

  it("handles file truncation gracefully", async () => {
    // The supervisor doesn't rotate logs, but truncation can happen
    // (manual `truncate`, disk pressure, accidental tooling). Per
    // log-match.ts policy: we don't try to re-read; we leave offset alone
    // and wait for the file to grow back past offset. The important
    // property is "don't crash". This test verifies that and the
    // post-truncation recovery path.
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

    // Truncate to zero. Don't crash; don't replay; don't deliver
    // anything new.
    truncateSync(logPath, 0);
    await sleep(40);
    expect(received).toEqual(["pre-trunc-1", "pre-trunc-2"]);

    // Now grow the file back. Because offset is still where it was, we
    // won't see lines until the file regrows past that offset. The
    // documented behavior (same as log-match.ts) is conservative on
    // purpose — we accept potentially losing lines after truncation
    // rather than risk delivering duplicates. Write enough content to
    // exceed the prior offset so the resume path fires.
    const padding = "x".repeat(200) + "\nresume-line\n";
    appendFileSync(logPath, padding);

    await waitFor(() => received.some((l) => l === "resume-line"), {
      timeoutMs: 2000,
    });
    expect(received).toContain("resume-line");
  });

  it("delivers lines to all surviving subscribers if one unsubscribes mid-emission", async () => {
    // Subscribers can unsubscribe during their own callback (e.g.
    // fail_when removes itself once it matches). The emission loop
    // snapshots subscribers before iterating, so removal during a tick
    // does not skip later subscribers.
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
    // A unsubscribed during 'first', so it does NOT see 'second'.
    expect(recvA).toEqual(["first"]);
    expect(recvB).toEqual(["first", "second"]);
  });

  it("a throwing subscriber does not block other subscribers", async () => {
    // The fan-out is defensive: a buggy callback shouldn't block the
    // rest. Documented in the onLine() doc comment; verified here.
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
    // The orchestrator's contract: a single AbortSignal ties every
    // LogTail's lifetime to the surrounding `lich up` invocation. When
    // the user hits Ctrl-C, that signal fires and every LogTail teardown
    // happens automatically — no per-tail `stop()` from the orchestrator.
    //
    // Verify: a running tail, after the signal fires, stops emitting.
    // We can't directly observe `stopped` (private), so we assert
    // behaviorally: lines written AFTER abort do not reach subscribers.
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

    // Fire the signal — equivalent to the orchestrator's Ctrl-C handler.
    ac.abort();

    // Give the abort listener a microtask to run. The listener calls
    // `void this.stop()` synchronously from `abort` dispatch, which is
    // enough for the `stopped` flag to be set before our next file write.
    await sleep(5);

    appendFileSync(logPath, "post-abort-1\npost-abort-2\n");

    // Wait longer than several intervalMs cycles to confirm no emission.
    // The "before stop" sleep cadence from the stop-mid-poll test is the
    // right comparison — same flake budget.
    await sleep(80);
    expect(received).toEqual(["pre-abort"]);
  });

  it("treats an already-aborted signal at construction as a born-stopped tail", async () => {
    // The orchestrator may construct LogTails while its cancellation
    // signal is already fired (e.g. the user Ctrl-C'd during the slow
    // initial `lich up` and we're still iterating the service registry).
    // In that case the LogTail must be born in the stopped state so
    // `start()` is a no-op — we don't want to schedule a poll loop that
    // will tick once and discover the signal is aborted.
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

    // start() must return immediately and NOT schedule a poll loop. If
    // it did schedule one, the subsequent appends would be emitted.
    await tail.start();

    appendFileSync(logPath, "never-emitted-1\nnever-emitted-2\n");

    await sleep(80);
    expect(received).toEqual([]);
  });

  it("start() after the signal fires is a no-op (no restart)", async () => {
    // Once aborted, a LogTail is permanently dead — `start()` cannot
    // resurrect it. This mirrors the stop()→start() permanence we
    // already have, and is the natural extension of "abort triggers
    // stop()". If a consumer somehow ends up calling start() after the
    // signal has fired (race in the orchestrator, etc.), it must be a
    // silent no-op rather than re-scheduling the poll loop on a dead
    // tail. Consumers that want a fresh tail construct a new instance.
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

    // Calling start() after abort must be a no-op — the LogTail must
    // not schedule a new poll loop.
    await tail.start();

    appendFileSync(logPath, "never-emitted\n");

    await sleep(80);
    expect(received).toEqual([]);
  });

  it("abort during a poll cycle does not deliver any further lines", async () => {
    // The interaction between an in-flight poll and abort: even if the
    // poll has already read bytes from the file and is mid-iteration
    // emitting them, an abort that fires partway through must terminate
    // the emission loop. The in-poll `stopped` check inside `readNewBytes`
    // enforces this; this test verifies the AbortSignal path triggers
    // that check via stop().
    //
    // The race is tight, but the `stopped` flag is set synchronously
    // from the abort listener's call to `stop()`, so any tick boundary
    // after abort respects it.
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

    // Burst a bunch of lines, then immediately abort. Depending on
    // exact timing, some may have been delivered before the abort
    // listener runs — but no NEW lines after the abort should appear.
    appendFileSync(logPath, "line-1\nline-2\nline-3\n");
    ac.abort();

    await sleep(80);

    // Subsequent appends are guaranteed to NOT reach subscribers — the
    // tail is dead. We can't be deterministic about which of line-1/2/3
    // were already delivered before the abort latched, but everything
    // after the cutoff must be absent.
    appendFileSync(logPath, "after-cutoff-1\nafter-cutoff-2\n");

    await sleep(80);
    expect(received).not.toContain("after-cutoff-1");
    expect(received).not.toContain("after-cutoff-2");
  });

  it("stop() called explicitly removes the abort listener so the signal can be GC'd cleanly", async () => {
    // Failure mode this guards: if a LogTail is stopped via `stop()` (not
    // via the signal), the abort listener must be removed from the signal.
    // Otherwise, on a long-lived orchestrator signal that has many
    // LogTails attached over a stack's lifetime, each completed-then-
    // stopped LogTail leaks a closure that retains `this`. Over a long
    // session, that's a slow memory leak.
    //
    // We verify by inspecting the AbortSignal's listener count via the
    // public addEventListener / removeEventListener interface plus a
    // tracked counter — there's no portable way to enumerate listeners,
    // so we wrap the methods.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    // Wrap the EventTarget methods to count abort listener registrations
    // and removals. We use a parameter type of `unknown[]` and forward via
    // `Reflect.apply` so we don't depend on the DOM lib types (the
    // tsconfig restricts `lib` to ESNext, so `EventListenerOrEventListenerObject`
    // isn't in scope here).
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
    expect(addCount).toBe(1); // constructor added our listener
    expect(removeCount).toBe(0);

    await tail.start();
    await tail.stop();

    // stop() must have called removeEventListener for the abort listener.
    expect(removeCount).toBe(1);
  });
});
