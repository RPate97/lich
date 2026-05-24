import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForLogMatch } from "../../../src/ready/log-match.js";
import { LogTail } from "../../../src/logs/tail.js";

// Plan 4 Task 4 — waitForLogMatch now consumes a LogTail rather than
// running its own poll loop. The behavioral contract is preserved:
// resolve on first matching line, reject with "aborted" on signal abort,
// honor pre-aborted signals. One new test verifies the retroactive-match
// behavior that LogTail.buffer unlocks (a match that landed BEFORE the
// caller subscribed still wins, closing the spawn-then-subscribe race
// window the orchestrator hits in `up.ts`).

// Track tmpdirs per test so afterEach can tear them all down.
let tmpDirs: string[] = [];
// Track LogTails per test so a failing assertion can't leak a polling
// interval into a later test.
let tails: LogTail[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lich-log-match-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Construct + start a LogTail for the given path with the test-default
 * poll interval. Tracked for afterEach cleanup so a throwing assertion
 * never leaves an interval running.
 */
async function startTail(logPath: string, intervalMs = 25): Promise<LogTail> {
  const tail = new LogTail({ logPath, intervalMs });
  tails.push(tail);
  await tail.start();
  return tail;
}

/**
 * Poll a predicate until it returns true or the deadline passes. Used
 * to wait for the LogTail's buffer to catch up to content the test just
 * wrote — keeps tests fast without depending on fixed sleeps.
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
    await new Promise((r) => setTimeout(r, intervalMs));
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

describe("waitForLogMatch", () => {
  it("resolves quickly when the log file already contains a matching line", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "starting...\nready: listening on 5432\nmore\n");

    // The tail needs a tick or two to ingest the pre-existing content
    // into its buffer before we call waitForLogMatch — otherwise we'd be
    // racing the LogTail's first poll. In practice up.ts would either
    // (a) hit the retroactive path because the buffer is already
    // populated, or (b) hit the subscriber path because the buffer is
    // empty at call time and the matching line arrives via onLine().
    // Either way, the wait succeeds. This test exercises path (a).
    const tail = await startTail(logPath);
    await waitFor(() => tail.buffer.includes("listening on 5432"));

    const start = Date.now();
    await waitForLogMatch({
      tail,
      pattern: /listening on \d+/,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("resolves once a matching line is appended after the wait begins", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    // File exists but no match yet.
    writeFileSync(logPath, "booting...\n");

    const tail = await startTail(logPath);
    // Drain the pre-existing non-matching content into the buffer so the
    // retroactive scan sees only the non-matching "booting..." line and
    // we deterministically take the subscriber path.
    await waitFor(() => tail.buffer.includes("booting"));

    const waiter = waitForLogMatch({
      tail,
      pattern: /server ready/,
    });

    setTimeout(() => {
      appendFileSync(logPath, "still booting\nserver ready now\n");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("waits for the log file to appear and resolves once it contains a match", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "not-yet.log");

    // LogTail tolerates a missing file at start() — it silently polls
    // until the file appears. The pre-existing standalone implementation
    // had the same property; the LogTail-based one inherits it.
    const tail = await startTail(logPath);

    const waiter = waitForLogMatch({
      tail,
      pattern: /hello/,
    });

    setTimeout(() => {
      writeFileSync(logPath, "hello world\n");
    }, 75);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  it("never resolves when the log never contains a match; abort terminates", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "nothing interesting\nstill nothing\n");

    const tail = await startTail(logPath);
    const controller = new AbortController();
    const waiter = waitForLogMatch({
      tail,
      pattern: /will-never-appear/,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 80);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("resolves on the specific matching line in a multi-line file (mid-file match)", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = await startTail(logPath);

    const waiter = waitForLogMatch({
      tail,
      pattern: /TARGET/,
    });

    setTimeout(() => {
      appendFileSync(
        logPath,
        "line 1\nline 2\nthis is the TARGET line\nline 4\n"
      );
    }, 50);

    await waiter;
  });

  it("does not match against a partial last line; only resolves once the line completes", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "");

    const tail = await startTail(logPath);

    const waiter = waitForLogMatch({
      tail,
      pattern: /^FULL-LINE$/,
    });

    // First write a partial fragment that LOOKS like it could match but
    // has no terminating newline. Then later finish the line. The
    // matcher must NOT resolve on the partial — only on the completed
    // line. This contract is enforced both by LogTail's per-line emission
    // (it carries the trailing partial in its own `pending` buffer and
    // only emits complete lines) AND by waitForLogMatch's retroactive
    // scan, which excludes the trailing partial from consideration. We
    // exercise the live-arrival path here; the next test covers the
    // retroactive path explicitly.
    setTimeout(() => {
      // "FULL-LIN" — no newline; partial only.
      appendFileSync(logPath, "FULL-LIN");
    }, 40);

    // The partial sits there for a while. If the implementation
    // incorrectly tests partials, this would falsely resolve in the
    // window before the completing write.
    setTimeout(() => {
      // Complete the line so that ^FULL-LINE$ matches.
      appendFileSync(logPath, "E\n");
    }, 150);

    const start = Date.now();
    await waiter;
    const elapsed = Date.now() - start;

    // Must have waited until after the completion write at t=150ms.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves on the FIRST matching line when multiple matches exist", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(
      logPath,
      "noise\nMATCH first\nMATCH second\nMATCH third\n"
    );

    const tail = await startTail(logPath);
    // Wait for the tail to ingest the whole file so the retroactive
    // scan has all four lines (or all are queued for the subscriber)
    // before we call into waitForLogMatch.
    await waitFor(() => tail.buffer.includes("MATCH third"));

    // We don't have a hook to introspect which line matched, but we can
    // assert resolution itself and that it completes quickly (i.e. the
    // function returns after the first match without scanning the
    // remainder forever).
    const start = Date.now();
    await waitForLogMatch({
      tail,
      pattern: /MATCH/,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("rejects with aborted when the signal fires during polling", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "noise only\n");

    const tail = await startTail(logPath);
    const controller = new AbortController();
    const waiter = waitForLogMatch({
      tail,
      pattern: /never/,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(waiter).rejects.toThrow(/abort/i);
  });

  it("rejects with aborted when the signal is already aborted before the call", async () => {
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(logPath, "anything\n");

    const tail = await startTail(logPath);
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForLogMatch({
        tail,
        pattern: /anything/,
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
  });

  it("matches a line that arrived BEFORE subscription via the LogTail buffer", async () => {
    // Plan 4 Task 4's headline new behavior: the orchestrator (`up.ts`)
    // spawns a service, then constructs a LogTail, then calls
    // waitForLogMatch. In the window between spawn and subscription, the
    // service may have already printed the matching ready line. The new
    // implementation closes that race by scanning `tail.buffer` for
    // already-complete lines that match the pattern BEFORE registering an
    // `onLine` subscriber.
    //
    // This test recreates that race deterministically: we let the tail
    // ingest a populated log (with the matching line present and
    // newline-terminated) into its buffer, then call waitForLogMatch.
    // The retroactive path must resolve without ever needing a new line
    // to arrive.
    const dir = makeTmpDir();
    const logPath = join(dir, "svc.log");
    writeFileSync(
      logPath,
      "starting up\ninitializing modules\nready: listening on 9999\n",
    );

    const tail = await startTail(logPath);
    // Wait for the tail to have read the file once — verified via the
    // buffer getter so we know the bytes are in memory and the
    // retroactive scan will see them.
    await waitFor(() => tail.buffer.includes("listening on 9999"));

    // Now subscribe. No new lines will be written. The match must come
    // from the retroactive buffer scan, not from a subscriber callback.
    const start = Date.now();
    await waitForLogMatch({
      tail,
      pattern: /listening on \d+/,
    });
    const elapsed = Date.now() - start;

    // Should resolve immediately (synchronously after the Promise
    // constructor body runs). A subscriber-path resolution would need at
    // least one more poll tick (intervalMs = 25 here), so a sub-25ms
    // resolution is strong evidence the retroactive path fired.
    expect(elapsed).toBeLessThan(25);
  });
});
