/**
 * Process-exit watcher — categorize owned-service exits by lifecycle stage
 * (Plan 4 Task 8).
 *
 * The owned-service supervisor (`packages/lich/src/owned/supervisor.ts`)
 * exposes an `OwnedHandle.exited` promise that resolves with the raw exit
 * code / signal — it does NOT know about lifecycle stages (during startup,
 * waiting for ready, post-ready). The orchestrator in `commands/up.ts` does
 * know, but the knowledge lives in a mutable variable that progresses as
 * the service moves through its lifecycle.
 *
 * `ProcessExitWatcher` bridges the two: the orchestrator constructs one
 * watcher per owned service and passes in a `readSignal` closure that
 * returns the current stage. When the underlying handle exits, the watcher
 * samples the stage at the moment of exit and surfaces it in the failure
 * payload alongside the exit code / signal.
 *
 * Why a closure rather than method calls or events? Keeping the watcher
 * dumb-and-passive avoids coupling it to up.ts's state machine:
 *   - up.ts owns the source of truth (the mutable `currentStage` variable
 *     local to its per-service startup function)
 *   - the watcher samples that source ONCE, at exit time
 *   - no event subscription, no method to call when transitioning stages,
 *     no risk of the watcher and up.ts disagreeing about the current stage
 *
 * The watcher also intentionally has NO opinion on what counts as a
 * "failure" beyond "code !== 0 || signal !== null". That matches the
 * supervisor's `OwnedHandle.exited` contract: a clean exit is code 0,
 * everything else is unexpected. Whether a `during_startup` exit is fatal
 * vs surprising-but-recoverable is up to the orchestrator; this watcher
 * just reports what happened and when.
 */

import type { OwnedHandle } from "../owned/supervisor.js";

/**
 * Lifecycle stage labels — match the design in Plan 4's spec. The
 * orchestrator transitions a service through these as it starts up:
 *
 *   1. `during_startup`  — between `startOwnedService` returning and
 *                          `waitReady` beginning. Catches immediate exits
 *                          like `cmd: exit 1` that die before lich even
 *                          starts polling for readiness.
 *   2. `before_ready`    — `waitReady` is polling (http_get, tcp,
 *                          log_match). A process that dies here didn't
 *                          satisfy its ready condition; the failure UX
 *                          should mention which condition was pending.
 *   3. `after_ready`     — service became ready, then died. Often the
 *                          most surprising kind — the service successfully
 *                          started, then crashed under its own steam.
 *                          Plan 4 Task 17 promotes the legacy 100ms early-
 *                          exit hack in up.ts into a watcher that catches
 *                          THIS stage too.
 */
export type LifecycleStage =
  | "during_startup"
  | "before_ready"
  | "after_ready";

/**
 * Discriminated union describing an unexpected exit. The `kind` field
 * distinguishes "exited with a non-zero status code" from "killed by a
 * signal" — these are categorically different events on POSIX and the
 * formatter / UX layer renders them differently.
 *
 * Clean exits (code 0) are NOT represented here — `wait()` returns `null`
 * in that case. Use `null` as the no-failure sentinel rather than a third
 * kind so callers get a clean `if (failure)` branch.
 */
export type ProcessExitFailure =
  | {
      /** Process called `exit(n)` (or returned from `main`) with non-zero `n`. */
      kind: "exit";
      /** The non-zero exit code reported by the kernel. Always set for this kind. */
      exitCode: number;
      /** Always null for exit-kind failures (kept for shape symmetry). */
      signalName: null;
      /** Lifecycle stage at the moment of exit, sampled from `readSignal()`. */
      stage: LifecycleStage;
    }
  | {
      /** Process was killed by an external signal (SIGKILL, SIGTERM from OOM, etc.). */
      kind: "signal";
      /** Always null for signal-kind failures (kept for shape symmetry). */
      exitCode: null;
      /** The signal that terminated the process (e.g. "SIGKILL"). Always set for this kind. */
      signalName: NodeJS.Signals;
      /** Lifecycle stage at the moment of exit, sampled from `readSignal()`. */
      stage: LifecycleStage;
    };

/** Options passed to the watcher constructor. */
export interface ProcessExitWatcherOptions {
  /**
   * Called at the moment of exit to determine which lifecycle stage the
   * service was in. The orchestrator typically implements this as a
   * closure over a mutable variable that it flips as the service
   * progresses (`'during_startup'` → `'before_ready'` → `'after_ready'`).
   *
   * Sampled ONCE per `wait()` call, at the moment the handle's `exited`
   * promise resolves. No replay, no subscription, no re-sampling on
   * subsequent reads of the result.
   */
  readSignal: () => LifecycleStage;
}

/**
 * Watch an owned service's exit and categorize the result.
 *
 * Construct one per owned service the orchestrator wants stage-aware exit
 * tracking on. Call `wait()` to get a single-shot promise that resolves
 * once the underlying handle exits:
 *   - clean exit (code 0)         → resolves with `null`
 *   - non-zero exit               → resolves with `{ kind: 'exit', exitCode, signalName: null, stage }`
 *   - killed by signal            → resolves with `{ kind: 'signal', exitCode: null, signalName, stage }`
 *
 * The watcher never rejects. It only observes the handle; it never
 * mutates it (no `stop()` calls, no signal dispatch). Pair with the
 * orchestrator's existing cancellation / cleanup path for the active
 * teardown side.
 *
 * Calling `wait()` more than once returns the SAME promise (the
 * underlying `exited` resolves once) — the watcher caches it lazily.
 */
export class ProcessExitWatcher {
  private readonly handle: OwnedHandle;
  private readonly opts: ProcessExitWatcherOptions;
  private cached: Promise<ProcessExitFailure | null> | null = null;

  constructor(handle: OwnedHandle, opts: ProcessExitWatcherOptions) {
    this.handle = handle;
    this.opts = opts;
  }

  /**
   * Resolve when the underlying `OwnedHandle.exited` resolves. Returns:
   *   - `null` for a clean exit (code === 0 && signal === null)
   *   - a `ProcessExitFailure` describing the exit otherwise
   *
   * Idempotent — calling more than once returns the same cached promise.
   * Never rejects unless `handle.exited` rejects (which the supervisor's
   * contract says it doesn't).
   */
  wait(): Promise<ProcessExitFailure | null> {
    if (this.cached !== null) return this.cached;
    this.cached = this.handle.exited.then((result) => {
      // Sample the stage AT the moment of exit — calling readSignal()
      // earlier (e.g. at construction time) would freeze the stage to
      // whatever it was when the watcher was built, which would mislabel
      // every after_ready exit as during_startup.
      const stage = this.opts.readSignal();

      // Clean exit — the supervisor's contract is that `code: 0,
      // signal: null` means "the service ran to completion without
      // incident." Surface that as `null` so callers get a clean
      // `if (failure)` branch.
      if (result.code === 0 && result.signal === null) {
        return null;
      }

      // Signal-killed processes have `code: null, signal: <name>`. The
      // supervisor's stop() path can legitimately produce this (SIGKILL
      // escalation), but so can external killers (OOM, the user
      // running `kill -9` themselves). We can't distinguish here —
      // the orchestrator's cancellation path is responsible for
      // suppressing failures from intentional shutdowns.
      if (result.signal !== null) {
        return {
          kind: "signal",
          exitCode: null,
          signalName: result.signal,
          stage,
        };
      }

      // Otherwise it's a non-zero exit code. `code` is guaranteed non-
      // null here: we've handled code===0 above (clean exit) and
      // signal !== null above (signal kill); the only remaining shape
      // per the supervisor's `ExitResult` is `code: number, signal: null`
      // with code !== 0.
      return {
        kind: "exit",
        // Non-null assertion: type narrowing above eliminates `code: null`.
        // `code: 0` was handled by the clean-exit branch; `signal != null`
        // was handled by the signal branch; the only remaining shape is
        // `code: <non-zero integer>, signal: null`.
        exitCode: result.code as number,
        signalName: null,
        stage,
      };
    });
    return this.cached;
  }
}

/**
 * Pure formatter for a `ProcessExitFailure`. Returns a single-line
 * human-readable description suitable for embedding in a larger failure
 * block (Plan 4 Task 9 `formatter.ts` composes these into the full UX).
 *
 * Examples:
 *   - `{ kind: 'exit', exitCode: 1, stage: 'during_startup' }`
 *     → `"exited with code 1 during startup"`
 *   - `{ kind: 'exit', exitCode: 137, stage: 'after_ready' }`
 *     → `"exited with code 137 after becoming ready"`
 *   - `{ kind: 'signal', signalName: 'SIGKILL', stage: 'before_ready' }`
 *     → `"killed by signal SIGKILL while waiting to become ready"`
 *
 * Intentionally minimal — no service name (the caller knows that), no
 * log tail (the failure-block formatter adds that), no ANSI color
 * (the output renderer adds that). One-liner so it composes cleanly.
 */
export function formatProcessExitFailure(
  failure: ProcessExitFailure,
): string {
  const stageDesc = describeStage(failure.stage);
  if (failure.kind === "exit") {
    return `exited with code ${failure.exitCode} ${stageDesc}`;
  }
  return `killed by signal ${failure.signalName} ${stageDesc}`;
}

/**
 * Render a `LifecycleStage` as the trailing phrase for `formatProcessExitFailure`.
 * Kept separate so future formatters (e.g. Plan 4 Task 9's failure block) can
 * reuse the same wording without restating the mapping. The exhaustive switch
 * is intentional: adding a new `LifecycleStage` variant will fail at compile
 * time here, forcing the new wording to be considered explicitly.
 */
function describeStage(stage: LifecycleStage): string {
  switch (stage) {
    case "during_startup":
      return "during startup";
    case "before_ready":
      return "while waiting to become ready";
    case "after_ready":
      return "after becoming ready";
  }
}
