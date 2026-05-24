/**
 * `LogTail` — separate-fd file reader for an owned service's log file.
 *
 * One physical log file, many logical consumers. Plan 4's failure-surfacing
 * work introduces multiple watchers that all want to see the same stream of
 * lines from a single owned service:
 *
 *   - `ready_when.log_match` (already exists, refactored onto LogTail in Task 4)
 *   - `fail_when.log_match` (Task 7) — racing the ready evaluator
 *   - `ready_when.capture` (Task 6) — retroactive regex against the buffer
 *   - the dashboard live-tail (Plan 5)
 *
 * Wiring each consumer with its own poll loop would duplicate the
 * read-bytes-and-split-on-newlines machinery N times AND re-open + re-read
 * the same file once per consumer per tick. `LogTail` encapsulates the
 * read-side machinery once and fans out new lines to N subscribers.
 *
 * ### Why a separate read fd (not a Node stream)?
 *
 * The supervisor (`packages/lich/src/owned/supervisor.ts`) spawns owned
 * services with `stdio: ["ignore", logFd, logFd]` — the child writes
 * directly through the kernel into the log file via the dup'd fd. There is
 * NO Node-side stdout stream to `.pipe()` from. This is deliberate: the
 * earlier Node-pipe approach caused Next.js dev to wedge into an infinite
 * `ERR_INVALID_URL` loop after the first HTTP request (see the long comment
 * in `supervisor.ts` around the `openSync(spec.logPath, "a")` call).
 *
 * Since the supervisor's write fd is opaque to us, every consumer must open
 * its own O_RDONLY fd on the same file and read forward — exactly what this
 * primitive does. The supervisor writes; LogTail reads; the kernel keeps
 * them coherent without any in-process coordination.
 *
 * ### Task 3 scope (this file's current state)
 *
 * Skeleton (Task 1) + poll loop + line fan-out + buffer accumulator
 * + AbortSignal-driven shutdown.
 *
 *   - `start()` schedules a `setInterval` that polls `stat(logPath)` at
 *     `intervalMs`. On size growth, opens the file, reads new bytes from
 *     the prior offset, closes, splits on `/\r?\n/`, and emits each
 *     complete line to every registered subscriber.
 *   - Trailing partial lines (no terminating newline) carry across ticks
 *     via an internal `pending` buffer so subscribers only ever see complete
 *     lines.
 *   - The `buffer` getter exposes ALL bytes read since `start()` was
 *     called — used by capture (Task 6) for retroactive regex matching.
 *   - File-doesn't-exist is silently tolerated (matches `log-match.ts`).
 *   - Truncation is treated as "no new bytes" (rotation is out of scope,
 *     same as `log-match.ts`).
 *   - `stop()` clears the interval, closes any open fd, and flips the
 *     `stopped` flag so an in-flight poll cannot emit after teardown.
 *   - When the optional `signal` constructor option fires, the LogTail
 *     auto-stops as if `stop()` had been called. If the signal is already
 *     aborted at construction time, the LogTail is born in the stopped
 *     state and any subsequent `start()` is a no-op. This wires the
 *     orchestrator's single cancellation source (a Ctrl-C handler in
 *     `lich up`) to every LogTail in a stack without forcing the caller
 *     to iterate the registry and call `stop()` N times.
 *
 * ### Design notes for future tasks
 *
 * - The class is intentionally NOT exposed via a factory function. Consumers
 *   need a stable handle they can call `.stop()` on at shutdown — `up.ts`
 *   keeps a `Map<serviceName, LogTail>` and tears them all down on cancel
 *   (Task 15). A factory that returned a `{ onLine, stop }` record would
 *   work too, but the class makes the lifecycle more obvious in stack traces.
 *
 * - We deliberately avoid `node:events`'s `EventEmitter`. A bare
 *   `Set<callback>` keeps the unsubscribe semantics obvious (the closure
 *   returned by `onLine` just calls `set.delete(cb)`), avoids the
 *   `max listeners` warning indirection, and makes the data flow easy to
 *   audit in a debugger. We expect at most a handful of subscribers per
 *   LogTail (one for ready, one for fail_when, optionally one for the
 *   dashboard) so EventEmitter's queueing optimizations are wasted here.
 *
 * - `intervalMs` defaults to 100ms, matching the existing `log-match.ts`
 *   poll cadence. Faster than http/tcp readiness probes because filesystem
 *   `stat` is cheap; fast enough that the perceived latency between a
 *   service emitting `ready_when.log_match` and lich noticing is sub-perceptible.
 *
 * - We deliberately avoid `fs.watch`. Its cross-platform semantics are
 *   inconsistent: macOS fires once per write coalescing, Linux fires per
 *   chunk, Windows is its own world. Polling at 100ms is fast enough for
 *   our use cases and predictable everywhere.
 */

import { open, stat } from "node:fs/promises";

/** Default poll cadence for the file `stat` loop. Matches `ready/log-match.ts`. */
const DEFAULT_INTERVAL_MS = 100;

/**
 * Cap on the in-memory `buffer` accumulator. A pathological service that
 * logs forever should not OOM lich; once we cross this cap, we drop the
 * oldest half of the buffer. Real services emit well under this before
 * becoming ready (typical: a few KB). 1 MiB is intentionally generous so
 * normal usage never trips the cap — but bounded enough that a tight log
 * loop can't run away.
 *
 * The cap applies ONLY to the retroactive `buffer` getter. Per-line
 * emission is unaffected — every line is still delivered to subscribers,
 * regardless of buffer state, because line delivery is a streaming
 * concern and the buffer is a retrospective one.
 */
const BUFFER_MAX_BYTES = 1024 * 1024;

/** Constructor options for `LogTail`. */
export interface LogTailOptions {
  /**
   * Absolute path to the per-service log file (typically
   * `state.serviceLogPath(stackId, name)`). The file does NOT need to exist
   * at construction time — `LogTail` polls and picks it up as soon as the
   * supervisor opens it for append.
   */
  logPath: string;
  /**
   * Poll interval in milliseconds for the internal `stat` loop. Defaults to
   * 100ms, matching `ready/log-match.ts`. Tests can lower this to keep
   * runtime tight; production has no reason to change it.
   */
  intervalMs?: number;
  /**
   * Optional cancellation signal. When it fires, the LogTail auto-stops as
   * if `stop()` had been called. Used by the orchestrator to tie the
   * LogTail's lifetime to the surrounding `lich up` invocation — when the
   * user hits Ctrl-C, every LogTail teardown happens via this one signal
   * rather than N explicit `stop()` calls.
   *
   * If the signal is already aborted at construction time, the LogTail is
   * born in the stopped state and any subsequent `start()` is a no-op —
   * the orchestrator's cancellation reached this LogTail before its first
   * tick, so there's nothing to start.
   */
  signal?: AbortSignal;
}

/**
 * Callback invoked once per complete log line. Receives the line content
 * with the trailing newline stripped. Carrying a trailing partial line
 * across poll ticks is `LogTail`'s responsibility, not the subscriber's —
 * subscribers always see complete lines, never half-formed chunks.
 */
export type LogLineCallback = (line: string) => void;

/**
 * Unsubscribe function returned by `onLine()`. Calling it removes the
 * registered callback from the internal subscriber set. Safe to call
 * multiple times — second-and-later calls are no-ops.
 */
export type Unsubscribe = () => void;

/**
 * Tails one log file and fans out new lines to N subscribers.
 *
 * Lifecycle:
 *   1. Construct with the target log path.
 *   2. Subscribe via `onLine(cb)` — register one or more callbacks. The
 *      subscribe order matters: lines emitted before `onLine()` was called
 *      are NOT replayed (use the `buffer` getter for retrospective access).
 *   3. Call `start()` to kick off the poll loop. Idempotent — calling it
 *      again on an already-started tail is a no-op.
 *   4. Call `stop()` (or trip the constructor's `signal`) to tear down.
 *      Idempotent. Safe to call before `start()`.
 *
 * Skeleton (Task 1) + poll loop (Task 2) + AbortSignal-driven shutdown
 * (Task 3).
 */
export class LogTail {
  /** Stored verbatim from the constructor; read by the poll loop. */
  private readonly logPath: string;
  /** Effective poll interval (caller's override or {@link DEFAULT_INTERVAL_MS}). */
  private readonly intervalMs: number;
  /**
   * Optional external cancellation signal. When non-null, the constructor
   * attaches a one-shot `abort` listener that calls `stop()` on fire — see
   * `attachAbort` below. We keep the reference so the listener can be
   * removed on `stop()`, avoiding a leaked subscription on a long-lived
   * AbortSignal (the orchestrator's signal can outlive any single LogTail).
   */
  private readonly signal: AbortSignal | undefined;

  /**
   * The abort listener attached to `this.signal`, if any. Captured so
   * `stop()` can remove it. Without this, a stop() that was caused by
   * something other than the signal (e.g. the orchestrator's per-service
   * teardown) would leave a dangling listener on a still-live signal,
   * keeping the LogTail object retained beyond its useful lifetime.
   */
  private abortListener: (() => void) | null = null;

  /**
   * Set of registered line callbacks. We use a bare `Set` rather than
   * `node:events`'s `EventEmitter` — the unsubscribe closure is just
   * `subscribers.delete(cb)`, which keeps the data flow obvious and avoids
   * the `max listeners` machinery we don't need at our subscriber count.
   *
   * Mutated by `onLine()` and the unsubscribe closure it returns. Iterated
   * by the poll loop on each new line.
   */
  private readonly subscribers: Set<LogLineCallback> = new Set();

  /**
   * Lifecycle flag: have we called `start()` yet? Used to short-circuit
   * repeat calls so the poll loop is only ever scheduled once.
   */
  private started = false;

  /**
   * Lifecycle flag: has `stop()` been called (or the AbortSignal fired)?
   * Once true, the LogTail is dead — subsequent `start()` calls are no-ops
   * and the poll loop must check this before scheduling its next tick.
   */
  private stopped = false;

  /**
   * Byte offset of the next read. Advances by `bytesRead` each tick.
   * Matches the offset-tracking approach in `ready/log-match.ts`.
   */
  private offset = 0;

  /**
   * Trailing partial-line buffer: bytes read on the previous tick that
   * did not end with a newline. Held until the next tick can finish the
   * line, ensuring subscribers only see complete lines.
   */
  private pending = "";

  /**
   * Accumulated content read since `start()` was called. Exposed via the
   * `buffer` getter for retrospective regex matching (capture in Task 6).
   *
   * Capped at {@link BUFFER_MAX_BYTES} — once exceeded, the oldest half
   * is dropped to bound memory. The cap is generous enough that normal
   * usage never trips it but bounded enough that a tight log loop on a
   * hung service won't OOM lich.
   */
  private bufferContent = "";

  /**
   * Handle for the active `setInterval` poll loop. `null` when the loop
   * is not scheduled (before `start()` or after `stop()`). Stored so
   * `stop()` can `clearInterval` it.
   */
  private timer: NodeJS.Timeout | null = null;

  /**
   * Guard against reentrant polls. A single poll may take longer than
   * `intervalMs` (especially on slow filesystems or large reads). Without
   * a guard, `setInterval` would fire the next tick while the previous is
   * still running and we'd read overlapping byte ranges. The flag is set
   * before each tick's I/O begins and cleared in `finally`.
   */
  private polling = false;

  constructor(opts: LogTailOptions) {
    this.logPath = opts.logPath;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.signal = opts.signal;

    // Wire the abort signal. Two distinct cases:
    //   1. Signal is already aborted — flip the LogTail straight to the
    //      stopped state. A subsequent `start()` returns immediately
    //      without scheduling the poll loop (the `if (this.stopped)`
    //      guard in `start()` handles it). This covers the case where
    //      the orchestrator's cancellation arrived BEFORE this LogTail
    //      was constructed (e.g. the user Ctrl-C's during a slow
    //      `lich up` and we're still building the per-service registry).
    //   2. Signal not yet aborted — attach a one-shot `abort` listener
    //      that calls `stop()`. We keep the listener reference on
    //      `this.abortListener` so `stop()` can remove it; this prevents
    //      a leaked subscription on long-lived signals (the
    //      orchestrator's signal outlives any single LogTail).
    if (this.signal !== undefined) {
      if (this.signal.aborted) {
        this.stopped = true;
      } else {
        // Fire-and-forget: stop() is async and idempotent. If a poll is
        // in flight when the signal fires, the in-poll stop-checks
        // ensure no further emissions slip out.
        this.abortListener = () => {
          void this.stop();
        };
        this.signal.addEventListener("abort", this.abortListener, {
          once: true,
        });
      }
    }
  }

  /**
   * Start the poll loop.
   *
   * Resolves immediately (the loop runs in the background; awaiting `start`
   * just means "the loop is now scheduled"). Idempotent — calling `start`
   * on an already-started tail is a no-op and returns the same resolved
   * promise shape.
   *
   * The read fd is opened lazily on each poll tick that finds growth, not
   * in `start()` itself — this lets callers construct and `start()` a
   * LogTail before the supervisor has spawned the service that will create
   * the log file.
   *
   * Calling `start()` after `stop()` is also a no-op. Once stopped, a
   * LogTail is permanently dead; consumers that want to "restart" tailing
   * should construct a fresh instance.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.started) return;
    this.started = true;

    // Schedule the poll loop. We don't `await` the first tick — `start()`
    // returns immediately and the loop runs in the background. Each tick
    // catches its own errors so a transient I/O failure doesn't kill the
    // loop. The reentrancy guard (`polling`) prevents overlapping ticks
    // when a slow read drags past `intervalMs`.
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  /**
   * Stop the poll loop and release any held resources.
   *
   * Idempotent — calling `stop()` repeatedly, or calling it before
   * `start()`, is safe and a no-op after the first call. Once stopped,
   * subscribers stop receiving lines even if the poll loop had a tick
   * in flight; the loop checks `this.stopped` before emitting.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Clear the interval so no further ticks fire. The currently-in-flight
    // tick (if any) checks `this.stopped` before emitting to subscribers,
    // so even a tick that's already past its I/O won't deliver lines after
    // stop. The interval handle is the only OS resource we own — file
    // handles are opened-and-closed per tick, never held between ticks,
    // so there's nothing else to release here.
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Remove our abort listener. Two reasons:
    //   1. Avoid leaking the listener (and therefore retaining `this`) on
    //      a still-live AbortSignal — the orchestrator's signal is a
    //      single instance shared across every LogTail in a stack, so it
    //      easily outlives any one LogTail being torn down ahead of the
    //      others (e.g. one service failed, we stop just its tail).
    //   2. Idempotency: if stop() was triggered BY the signal firing, the
    //      `{ once: true }` flag has already removed the listener; the
    //      explicit `removeEventListener` is a harmless no-op in that case.
    if (this.signal !== undefined && this.abortListener !== null) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = null;
    }
  }

  /**
   * Subscribe to new log lines.
   *
   * Returns an unsubscribe function. Calling the returned function removes
   * the callback from the internal subscriber set. The unsubscribe is safe
   * to call multiple times — it's just `set.delete(cb)`, which is a no-op
   * on the second and later invocations.
   *
   * Lines emitted to the file BEFORE `onLine()` is registered are NOT
   * replayed to the new subscriber. Consumers that need a retrospective
   * view (e.g. `ready_when.capture` extracting a value the service printed
   * before the orchestrator wired up its watcher) should use the `buffer`
   * getter, which retains everything read since `start()`.
   *
   * Subscribers are invoked synchronously inside the poll loop, in
   * registration order. A throwing subscriber must NOT prevent later
   * subscribers from being invoked — the poll loop wraps each invocation
   * in a try/catch and swallows the error. (Logging the error usefully
   * requires an output channel we don't have here; consumers that need
   * to know about subscriber failures should wrap their own callback.)
   */
  onLine(cb: LogLineCallback): Unsubscribe {
    this.subscribers.add(cb);
    // Closure over `cb` and `this.subscribers`. Repeated calls are safe
    // because `Set.delete` is itself idempotent.
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * The full accumulated log content since `start()` was called.
   *
   * Used by `ready_when.capture` (Task 6) to run retrospective regexes
   * against everything the service has emitted, including lines that
   * landed before the capture extractor subscribed. Subscribers that
   * only care about new lines should ignore this getter and use
   * `onLine()` instead.
   *
   * Bounded by {@link BUFFER_MAX_BYTES}: once exceeded, the oldest half
   * is dropped. This caps memory use in pathological cases (a service
   * that logs forever) while leaving normal usage entirely unaffected.
   * The cap applies only to this getter; per-line emission via `onLine`
   * is unaffected — every line is delivered as it's read.
   */
  get buffer(): string {
    return this.bufferContent;
  }

  /**
   * One tick of the poll loop. Stat the file, if it grew read the new
   * bytes, split into lines, deliver each complete line to every
   * subscriber. Carries the trailing partial line across ticks via
   * `this.pending`.
   *
   * Mirrors the polling shape from `ready/log-match.ts` lines 50-142.
   * That code has been battle-tested through Plan 1; we keep the same
   * structure so any future bug found in either place can be fixed in
   * both with confidence.
   *
   * Errors during stat/read are silently swallowed (matches log-match.ts).
   * ENOENT before the supervisor spawns the service is the common case;
   * other transient I/O errors are also non-fatal and recoverable on the
   * next tick.
   */
  private async poll(): Promise<void> {
    // Stop-check up front: a tick may have been scheduled before stop()
    // fired. Bail without I/O so we don't waste a stat() on a dead tail.
    if (this.stopped) return;

    // Reentrancy guard: setInterval can fire a new tick while the previous
    // is still awaiting I/O. Skip overlapping ticks — the next interval
    // will catch up. This is exactly the behavior we want for a polling
    // loop where each tick is expected to be cheap.
    if (this.polling) return;
    this.polling = true;

    try {
      let size: number | null = null;
      try {
        const st = await stat(this.logPath);
        size = st.size;
      } catch {
        // ENOENT is expected before the service starts writing. Any other
        // error (permission denied, broken filesystem) is also non-fatal —
        // we just keep polling. If the user genuinely misconfigured the
        // path, ready_when.timeout (Task 5) will surface that as a
        // ReadyTimeoutError eventually.
      }

      // Stop-check after I/O: if stop() fired while we were awaiting
      // stat, abandon the tick before any emission.
      if (this.stopped) return;

      if (size === null) return;

      if (size > this.offset) {
        // File grew. Read the new bytes.
        await this.readNewBytes(size);
      }
      // If size < this.offset, the file was truncated (rotation, manual
      // deletion). We don't try to handle it: the supervisor doesn't
      // rotate, and re-reading a rotated file would deliver lines twice.
      // Conservative behavior: leave offset alone; if the file grows back
      // past offset, we'll resume. Same policy as log-match.ts.
    } finally {
      this.polling = false;
    }
  }

  /**
   * Read the bytes in [`this.offset`, `size`) from the log file, split
   * them into lines, and emit each complete line to subscribers.
   *
   * Opens an O_RDONLY fd, reads, closes. We do not hold the fd between
   * ticks because the supervisor writes through its own dup'd fd (via
   * `stdio: ["ignore", logFd, logFd]`) and re-opening per tick guarantees
   * we see the current file content even across unlink/rename (which the
   * supervisor doesn't do, but it's a cheap correctness property).
   */
  private async readNewBytes(size: number): Promise<void> {
    const length = size - this.offset;
    const buf = Buffer.allocUnsafe(length);

    let handle;
    try {
      handle = await open(this.logPath, "r");
    } catch {
      // File vanished between stat and open. Rare; ignore and try next tick.
      return;
    }

    let bytesRead = 0;
    try {
      const r = await handle.read(buf, 0, length, this.offset);
      bytesRead = r.bytesRead;
    } catch {
      // Transient read failure. Don't advance offset; next tick will retry.
      return;
    } finally {
      try {
        await handle.close();
      } catch {
        // Already closed or fd reclaimed — harmless.
      }
    }

    if (bytesRead <= 0) return;
    this.offset += bytesRead;

    // Stop-check after I/O completes but before emitting: a stop() that
    // fired mid-read MUST prevent the emission. The poll-loop spec says
    // "stop() halts emission even if a poll is in flight" — this is the
    // line that enforces it.
    if (this.stopped) return;

    const chunk = buf.slice(0, bytesRead).toString("utf8");

    // Accumulate into the retrospective buffer first. The buffer reflects
    // ALL bytes read, regardless of whether they form complete lines —
    // capture (Task 6) runs its regex against the raw byte stream, not
    // line-by-line, so partial lines at the end of the buffer are fine.
    this.appendToBuffer(chunk);

    // Now line-split for subscriber emission. Carry the partial trailing
    // line via this.pending so subscribers only see complete lines.
    this.pending += chunk;

    const lastNewline = this.pending.lastIndexOf("\n");
    if (lastNewline < 0) {
      // No complete line in this chunk — keep pending and wait for the
      // next tick to finish it.
      return;
    }

    const complete = this.pending.slice(0, lastNewline);
    this.pending = this.pending.slice(lastNewline + 1);

    // Split on `\r?\n` so CRLF logs don't leak a stray `\r` into the line
    // content. Same regex as log-match.ts.
    const lines = complete.split(/\r?\n/);
    for (const line of lines) {
      // Stop-check inside the line loop: a long burst of lines should
      // abort cleanly if stop() fires mid-iteration. Subscribers that
      // already got their line before stop are NOT taken back, but new
      // emissions cease immediately.
      if (this.stopped) return;
      this.emitLine(line);
    }
  }

  /**
   * Deliver one line to every registered subscriber.
   *
   * Subscribers are invoked synchronously, in registration order. A
   * subscriber that throws does NOT prevent later subscribers from
   * receiving the line — we wrap each invocation in try/catch and swallow
   * the error. There's no useful place to log it from here: the LogTail
   * has no output channel of its own, and the caller registered the
   * callback so the caller's responsibility is to handle its own errors.
   *
   * We snapshot `Array.from(subscribers)` before iterating so that a
   * subscriber unsubscribing during emission (e.g. fail_when fires and
   * removes itself) doesn't perturb the loop. ES `Set` iteration is
   * "live" — modifying the set during iteration would otherwise skip or
   * double-visit entries depending on the modification.
   */
  private emitLine(line: string): void {
    const snapshot = Array.from(this.subscribers);
    for (const cb of snapshot) {
      try {
        cb(line);
      } catch {
        // Subscriber threw; ignore and continue.
      }
    }
  }

  /**
   * Append `chunk` to the retrospective `bufferContent`. If the result
   * exceeds {@link BUFFER_MAX_BYTES}, drop the oldest half so memory
   * stays bounded. We measure in JavaScript string length (UTF-16 code
   * units) rather than UTF-8 byte count — close enough at this scale,
   * and avoids the cost of re-encoding for the size check.
   */
  private appendToBuffer(chunk: string): void {
    this.bufferContent += chunk;
    if (this.bufferContent.length > BUFFER_MAX_BYTES) {
      // Drop the oldest half. Slicing at `length / 2` rather than
      // `length - BUFFER_MAX_BYTES` is a deliberate choice: we want to
      // amortize the cost of trimming across many writes, so we trim in
      // big chunks rather than every poll once over the limit. This
      // keeps the average buffer size around ~0.5x to ~1x of the cap.
      this.bufferContent = this.bufferContent.slice(
        Math.floor(this.bufferContent.length / 2),
      );
    }
  }
}
