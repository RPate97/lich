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
 * ### Skeleton scope (Task 1)
 *
 * This file ships the class shape only:
 *   - constructor accepts `logPath`, optional `intervalMs`, optional `signal`
 *   - `start()` / `stop()` are idempotent lifecycle methods (no-op body for now)
 *   - `onLine(cb)` returns an unsubscribe function (registration shape only)
 *   - `buffer` getter returns "" (real accumulator wired in Task 2)
 *
 * The poll loop + line emission lands in Task 2; AbortSignal-driven shutdown
 * in Task 3. Splitting the skeleton from the runtime behavior makes the API
 * surface independently reviewable and gives downstream tasks (4-7) a stable
 * import target while their own code is being written in parallel.
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
 */

/** Default poll cadence for the file `stat` loop. Matches `ready/log-match.ts`. */
const DEFAULT_INTERVAL_MS = 100;

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
   * Wired in Task 3. The Task 1 skeleton accepts and stores the option but
   * does not yet react to abort events.
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
 * The skeleton (Task 1) implements the API shape; the poll loop (Task 2)
 * and AbortSignal wiring (Task 3) fill in the behavior.
 */
export class LogTail {
  /** Stored verbatim from the constructor; read by the poll loop in Task 2. */
  private readonly logPath: string;
  /** Effective poll interval (caller's override or {@link DEFAULT_INTERVAL_MS}). */
  private readonly intervalMs: number;
  /**
   * Optional external cancellation signal. Stored for the AbortSignal wiring
   * Task 3 will add; the Task 1 skeleton accepts the option for API stability
   * but does not yet attach an `abort` listener.
   */
  private readonly signal: AbortSignal | undefined;

  /**
   * Set of registered line callbacks. We use a bare `Set` rather than
   * `node:events`'s `EventEmitter` — the unsubscribe closure is just
   * `subscribers.delete(cb)`, which keeps the data flow obvious and avoids
   * the `max listeners` machinery we don't need at our subscriber count.
   *
   * Mutated by `onLine()` and the unsubscribe closure it returns. Iterated
   * by the poll loop in Task 2 on each new line.
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
   * and the poll loop (Task 2) must check this before scheduling its next
   * tick.
   */
  private stopped = false;

  constructor(opts: LogTailOptions) {
    this.logPath = opts.logPath;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.signal = opts.signal;
  }

  /**
   * Start the poll loop.
   *
   * Resolves immediately (the loop runs in the background; awaiting `start`
   * just means "the loop is now scheduled"). Idempotent — calling `start`
   * on an already-started tail is a no-op and returns the same resolved
   * promise shape.
   *
   * The read fd is opened lazily on the first poll that finds a non-empty
   * file (Task 2), not in `start()` itself — this lets callers construct
   * and `start()` a LogTail before the supervisor has spawned the service
   * that will create the log file.
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
    // Poll-loop scheduling lands in Task 2. The skeleton just flips the
    // flag so the idempotency contract is observable from tests.
  }

  /**
   * Stop the poll loop and release any held resources.
   *
   * Idempotent — calling `stop()` repeatedly, or calling it before
   * `start()`, is safe and a no-op after the first call. Once stopped,
   * subscribers stop receiving lines even if the poll loop had a tick
   * in flight; the loop checks `this.stopped` before emitting.
   *
   * The Task 2 implementation will close the read fd and clear the
   * internal `setInterval` timer here. The Task 1 skeleton just flips
   * the flag.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // fd close + interval clear land in Task 2. The skeleton just flips
    // the flag so idempotency and post-stop start() are observable.
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
   * subscribers from being invoked — the Task 2 loop wraps each invocation
   * in a try/catch and swallows the error. (Logging the error usefully
   * requires an output channel we don't have here; consumers that need
   * to know about subscriber failures should wrap their own callback.)
   *
   * The Task 1 skeleton registers the callback but never invokes it (the
   * poll loop lands in Task 2). The returned unsubscribe still works.
   */
  onLine(cb: LogLineCallback): Unsubscribe {
    this.subscribers.add(cb);
    // Closure over `cb` and `this.subscribers`. Repeated calls are safe
    // because `Set.delete` is itself idempotent. We don't null out `cb`
    // after delete because the closure is single-use from the consumer's
    // perspective — leaks here are bounded by the subscriber's lifetime.
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
   * Task 2 will replace the empty-string body with a real accumulator
   * that grows as the poll loop reads new bytes. To bound memory in
   * pathological cases (a service that emits log lines in a tight loop
   * forever) Task 2 will cap the buffer at ~1MB and drop the oldest
   * half when it overflows.
   *
   * Returning "" from the skeleton is deliberate: it makes the API
   * shape observable without committing the test suite to behavior the
   * skeleton doesn't yet implement.
   */
  get buffer(): string {
    return "";
  }
}
