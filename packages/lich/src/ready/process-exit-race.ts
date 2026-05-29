/**
 * `failOnExitDuringReady` — race a ready evaluator against an owned service's
 * process-exit signal. ANY exit during the ready wait (including a clean
 * code-0 exit) is treated as failure: the service was supposed to stay alive
 * until ready fired. Without this, a clean exit mid-ready would convert to a
 * never-resolving promise and the wait would hang until ready_when.timeout.
 */
import type { ProcessExitWatcher } from "../failure/process-exit.js";
import type { ProcessExitFailure } from "../failure/process-exit.js";

export interface FailOnExitDuringReadyOptions<T> {
  /**
   * The ready evaluator promise (typically `withTimeout`-wrapped). Mirrored
   * unchanged when it wins the race.
   */
  readyPromise: Promise<T>;
  /**
   * The per-service `ProcessExitWatcher`. MUST be the same instance the
   * orchestrator registered in `state.exitWatchers` — a fresh watcher would
   * race the supervisor's exit handler differently and lose stage labeling.
   */
  exitWatcher: ProcessExitWatcher;
  /** The owned service's name, embedded in the error message. */
  serviceName: string;
}

/**
 * Returns a promise that:
 *   - mirrors `readyPromise` if ready resolves first
 *   - rejects with `Error` carrying a `ProcessExitFailure` cause if the
 *     process exits first (regardless of exit code)
 */
export function failOnExitDuringReady<T>(
  opts: FailOnExitDuringReadyOptions<T>,
): Promise<T> {
  const { readyPromise, exitWatcher, serviceName } = opts;

  // The chain ALWAYS throws — re-throwing the watcher's structured failure
  // (non-zero exit or signal kill), or synthesizing one for clean-exit. The
  // racer never wins by resolving, only by rejecting.
  //
  // ProcessExitWatcher was designed to surveil long-lived services where a
  // code-0 exit AFTER ready is "shut down on its own; not a failure." Inside
  // ready_when, that interpretation flips — we re-interpret the null here
  // rather than changing the watcher's post-ready surveillance semantic.
  const exitRacer = exitWatcher.wait().then((failure) => {
    if (failure !== null) {
      const err = new Error(
        `owned service "${serviceName}" exited during ready wait`,
      );
      (err as Error & { cause?: unknown }).cause = failure;
      throw err;
    }
    // Clean exit (code 0, no signal) DURING ready_when is still a failure.
    // Stage hard-coded to `before_ready`: by definition, we're inside
    // `waitReady`'s race when this code runs.
    const synthetic: ProcessExitFailure = {
      kind: "exit",
      exitCode: 0,
      signalName: null,
      stage: "before_ready",
    };
    const err = new Error(
      `owned service "${serviceName}" exited cleanly during ready wait`,
    );
    (err as Error & { cause?: unknown }).cause = synthetic;
    throw err;
  });

  return Promise.race([readyPromise, exitRacer]);
}
