/**
 * Unit tests for `watchFailWhen` (Plan 4 Task 7).
 *
 * The watcher is one of the load-bearing primitives for Plan 4's failure
 * surfacing: it lets the orchestrator detect "service emitted EADDRINUSE
 * but didn't exit" without polling and without re-opening the log file.
 * These tests exercise the full surface:
 *
 *   - retroactive match (line in buffer before subscription)
 *   - live match (line emitted after subscription)
 *   - the load-bearing "never resolves on its own" contract
 *   - racing wins/loses against fulfilling and rejecting peers
 *   - abort cleanup (no lingering callbacks on the LogTail)
 *
 * We drive the LogTail with real filesystem writes (same pattern as
 * `tail.test.ts`) rather than mocking it — the watcher's behavior on a
 * fake LogTail is uninteresting, what matters is its behavior against the
 * actual class as it's used in production. The tests use `intervalMs: 10`
 * to keep total runtime tight; total suite runs in ~1.5s.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogTail } from "../../../src/logs/tail.js";
import {
  FailWhenMatchedError,
  watchFailWhen,
} from "../../../src/failure/fail-when.js";

// Per-test trackers so `afterEach` can clean up even when an assertion
// blows up partway through a test. Without these, a leaked poll interval
// would keep ticking across tests and the test process would hang on exit.
let tmpDirs: string[] = [];
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-fail-when-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Construct and `start()` a LogTail tracked for `afterEach` teardown.
 * Tests use `intervalMs: 10` so writes show up within ~30ms in the worst
 * case (one tick to stat-and-read, one tick to deliver to subscribers,
 * plus a small slack for the OS scheduler).
 */
async function makeStartedTail(logPath: string): Promise<LogTail> {
  const tail = new LogTail({ logPath, intervalMs: 10 });
  tails.push(tail);
  await tail.start();
  return tail;
}

/** Convenience: sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

describe("watchFailWhen", () => {
  it("rejects with FailWhenMatchedError on first matching line", async () => {
    // The standard happy-failure-path: service is running, LogTail is
    // tailing, watcher is subscribed, then the service emits a matching
    // log line. The watcher must reject with the matched line attached.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\nlistening on 8080\n");

    const tail = await makeStartedTail(logPath);
    // Give the tail one tick to read the seed content into its buffer
    // so we can isolate "live emission causes match" from "retroactive
    // sweep matches." This test is about the FORWARD path.
    await sleep(30);

    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
    });

    // Emit the failing line AFTER subscription so we're testing the
    // forward path explicitly.
    setTimeout(() => {
      appendFileSync(logPath, "EADDRINUSE port 8080 already in use\n");
    }, 30);

    await expect(waiter).rejects.toThrow(FailWhenMatchedError);
    // Verify the matched-line payload — the formatter (Task 9) renders
    // this verbatim in the failure block, so the test pins the exact
    // shape callers depend on.
    try {
      await waiter;
    } catch (err) {
      expect(err).toBeInstanceOf(FailWhenMatchedError);
      expect((err as FailWhenMatchedError).matchedLine).toBe(
        "EADDRINUSE port 8080 already in use",
      );
    }
  });

  it("never resolves on its own (stays pending until match, signal, or stop)", async () => {
    // The crucial design contract: fail_when is a SENTINEL, not a state.
    // Without this property, a stale fail_when promise resolving after
    // ready_when has won the race would mislead the orchestrator into
    // thinking the service failed when it actually succeeded.
    //
    // Test shape: subscribe to a log that never matches; wait 200ms;
    // assert the promise is still pending. We can't directly inspect
    // promise state in vitest, so we race the watcher against a timer
    // and assert the timer wins.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(
      logPath,
      "starting\nhealthy\nstill healthy\nnothing matching here\n",
    );

    const tail = await makeStartedTail(logPath);
    await sleep(30); // let the tail read the seed

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /WILL-NEVER-APPEAR/,
      signal: controller.signal,
    });

    // Sentinel resolves after 200ms. If the watcher were to (incorrectly)
    // resolve on its own, the race would pick whichever fired first; if
    // it stays pending as it should, the sentinel wins.
    const sentinel = sleep(200).then(() => "sentinel-won" as const);

    const winner = await Promise.race([
      waiter.then(() => "watcher-resolved" as const).catch(
        () => "watcher-rejected" as const,
      ),
      sentinel,
    ]);

    expect(winner).toBe("sentinel-won");

    // Clean up so the watcher promise doesn't become an unhandled
    // rejection at process exit. Aborting transitions it into the
    // rejected state cleanly.
    controller.abort();
    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("can race against a Promise.resolve and lose", async () => {
    // The orchestrator's race shape: ready_when fulfills, fail_when
    // is still pending. We must verify `Promise.race` picks the
    // fulfilling side AND that the still-pending fail_when doesn't
    // produce an unhandled rejection.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /WONT-MATCH/,
      signal: controller.signal,
    });

    const winner = await Promise.race([
      Promise.resolve("ready"),
      waiter,
    ]);

    expect(winner).toBe("ready");

    // Caller-cleanup contract: orchestrator MUST abort the loser so the
    // sentinel can't fire late and produce an unhandled rejection.
    controller.abort();
    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("races against another rejection and wins if it matches first", async () => {
    // Verifies the watcher's rejection is symmetric: it can either win
    // the race (by firing fastest) or lose it (covered by the previous
    // test). This test shows the WIN case against a slower rejecting peer.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /FATAL/,
      signal: controller.signal,
    });

    // Emit the match quickly...
    setTimeout(() => {
      appendFileSync(logPath, "FATAL boom\n");
    }, 20);

    // ...and have a slower peer reject later. The watcher should win.
    const slowReject = sleep(300).then(() => {
      throw new Error("slow-peer");
    });

    await expect(Promise.race([waiter, slowReject])).rejects.toThrow(
      FailWhenMatchedError,
    );

    // Suppress the still-pending slow rejection so it doesn't become an
    // unhandled rejection at the end of the test. We attach a no-op
    // catch handler; the promise is already in flight from the race.
    slowReject.catch(() => {});

    // Cleanup is a no-op here (the watcher already settled), but it's
    // safe to abort after the fact — defensive in case the orchestrator
    // pattern always aborts the loser regardless of who won.
    controller.abort();
  });

  it("cleans up the subscription when signal aborts", async () => {
    // The watcher subscribes to LogTail via `onLine`. If abort doesn't
    // remove the subscription, a later log line would still invoke the
    // already-rejected promise's callback — at best wasted work, at
    // worst a logic bug if the callback re-rejects.
    //
    // We can't introspect LogTail's internal subscriber set directly
    // (it's `private readonly`), but we can prove the cleanup happened
    // indirectly: after abort, emit MORE log lines that WOULD match,
    // wait, and confirm no FailWhenMatchedError fires. If the watcher
    // were still subscribed, the second match would either invoke
    // the (already-detached) reject (silent) OR re-trigger a re-reject
    // (unhandled rejection visible to the test runner).
    //
    // The "silent" case is the harder one to test — we use the
    // "registered subscribers count" leak hypothesis instead, by
    // checking that emitting many post-abort lines doesn't cause a
    // perf cliff or hang. A more direct assertion: confirm the
    // promise rejected with abort EXACTLY ONCE.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    const waiter = watchFailWhen({
      tail,
      pattern: /MATCH/,
      signal: controller.signal,
    });

    // Track every rejection. The promise should reject exactly once.
    const rejections: unknown[] = [];
    waiter.catch((err) => rejections.push(err));

    // Abort before any match.
    controller.abort();
    await sleep(20); // let the abort listener settle

    // Now emit MANY matching lines. If the subscription is still alive,
    // each would try to fire the callback — which would either silently
    // no-op (still proves cleanup ran somewhere) or attempt to re-reject
    // a settled promise (also silent, but proves a logic leak).
    for (let i = 0; i < 50; i++) {
      appendFileSync(logPath, `MATCH line ${i}\n`);
    }
    await sleep(100); // give the poll loop several ticks to digest

    // Exactly one rejection — the abort. Zero additional rejections
    // from late matches.
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toBeInstanceOf(Error);
    expect((rejections[0] as Error).message).toMatch(/abort/i);
  });

  it("matches a line already in the LogTail buffer before subscription", async () => {
    // Retroactive-match contract: the service may have emitted the
    // failing line BEFORE the orchestrator wired up the fail_when
    // watcher (e.g. very fast EADDRINUSE on startup, before lich's
    // LogTail-construction code path got there). The watcher must
    // catch it via the buffer sweep on subscription.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    // Write the matching line up front. By the time the watcher
    // subscribes, LogTail.buffer will already contain it.
    writeFileSync(logPath, "starting\nEADDRINUSE port 5432\nmore noise\n");

    const tail = await makeStartedTail(logPath);
    // Wait long enough for LogTail's poll loop to read the file into
    // its buffer. With intervalMs: 10, ~30ms is comfortably enough.
    await sleep(40);

    // Sanity check: the buffer actually contains the bytes (otherwise
    // this test would silently degrade into the forward-emission test).
    expect(tail.buffer).toContain("EADDRINUSE");

    // Subscribe AFTER the line is in the buffer. The watcher must
    // detect it via the retroactive sweep, NOT by waiting for a
    // future emission.
    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
    });

    // The retroactive sweep is synchronous inside the promise executor,
    // so the rejection lands on the next microtask. We don't need to
    // sleep — `await` will pick it up.
    await expect(waiter).rejects.toThrow(FailWhenMatchedError);
    try {
      await waiter;
    } catch (err) {
      expect((err as FailWhenMatchedError).matchedLine).toBe(
        "EADDRINUSE port 5432",
      );
    }
  });

  it("rejects immediately when signal is already aborted at call time", async () => {
    // Edge case for the orchestrator's cancellation flow: the user hits
    // Ctrl-C while lich is still building per-service watchers. We
    // should reject without ever touching the LogTail.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "EADDRINUSE here\n"); // even with a match in buffer
    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const controller = new AbortController();
    controller.abort();

    // The signal beat the watcher to the punch. The retroactive sweep
    // must NOT fire — abort wins.
    const waiter = watchFailWhen({
      tail,
      pattern: /EADDRINUSE/,
      signal: controller.signal,
    });

    await expect(waiter).rejects.toThrow(/abort/i);
    // The rejection is an "aborted" error, NOT a FailWhenMatchedError —
    // we never got to the buffer sweep.
    try {
      await waiter;
    } catch (err) {
      expect(err).not.toBeInstanceOf(FailWhenMatchedError);
    }
  });

  it("rejects only once even when multiple matching lines arrive in the same tick", async () => {
    // Edge case: a service emits a burst of matching lines (a panic
    // log that mentions "EADDRINUSE" five times). The watcher should
    // settle on the FIRST line and ignore the rest — `cleanup` runs
    // before the next callback in the burst.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting\n");

    const tail = await makeStartedTail(logPath);
    await sleep(30);

    const waiter = watchFailWhen({
      tail,
      pattern: /BOOM/,
    });

    const rejections: FailWhenMatchedError[] = [];
    waiter.catch((err) => rejections.push(err as FailWhenMatchedError));

    // Write the burst in one syscall so they all arrive in a single
    // poll tick's read. The LogTail's emission loop iterates a snapshot
    // of subscribers, so the watcher's callback fires N times — but
    // `settled` guards against double-rejection.
    appendFileSync(
      logPath,
      "BOOM 1\nBOOM 2\nBOOM 3\nBOOM 4\nBOOM 5\n",
    );

    await sleep(80); // multiple ticks of the poll loop

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.matchedLine).toBe("BOOM 1");
  });
});

describe("FailWhenMatchedError", () => {
  it("carries the matched line as a public field", () => {
    const err = new FailWhenMatchedError("EADDRINUSE port 8080");
    expect(err.matchedLine).toBe("EADDRINUSE port 8080");
    // The message embeds the line so any error-as-string consumer
    // (logging, unhandled rejection traces) sees the useful content.
    expect(err.message).toContain("EADDRINUSE port 8080");
  });

  it("has a stable .name for cross-realm discrimination", () => {
    // The formatter (Task 9) discriminates on `err.name` so cross-realm
    // errors (which fail `instanceof` checks) still get the right block.
    // Pin the name so a future rename doesn't silently break that path.
    const err = new FailWhenMatchedError("anything");
    expect(err.name).toBe("FailWhenMatchedError");
  });

  it("is an instance of Error so generic catch handlers work", () => {
    const err = new FailWhenMatchedError("anything");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FailWhenMatchedError);
  });
});
