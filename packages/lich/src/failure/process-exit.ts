import type { OwnedHandle } from "../owned/supervisor.js";

export type LifecycleStage =
  | "during_startup"
  | "before_ready"
  | "after_ready";

export type ProcessExitFailure =
  | {
      kind: "exit";
      exitCode: number;
      signalName: null;
      stage: LifecycleStage;
    }
  | {
      kind: "signal";
      exitCode: null;
      signalName: NodeJS.Signals;
      stage: LifecycleStage;
    };

export interface ProcessExitWatcherOptions {
  /** Sampled once at exit time to determine the lifecycle stage. */
  readSignal: () => LifecycleStage;
}

/**
 * Watch an owned service's exit and categorize the result.
 *
 * `wait()` resolves with `null` for clean exits, or a `ProcessExitFailure`
 * otherwise. Idempotent; never rejects. The watcher only observes — it never
 * calls `stop()` or signals the handle.
 */
export class ProcessExitWatcher {
  private readonly handle: OwnedHandle;
  private readonly opts: ProcessExitWatcherOptions;
  private cached: Promise<ProcessExitFailure | null> | null = null;

  constructor(handle: OwnedHandle, opts: ProcessExitWatcherOptions) {
    this.handle = handle;
    this.opts = opts;
  }

  wait(): Promise<ProcessExitFailure | null> {
    if (this.cached !== null) return this.cached;
    this.cached = this.handle.exited.then((result) => {
      // Sample at exit time — sampling at construction would mislabel every
      // after_ready exit as during_startup.
      const stage = this.opts.readSignal();

      if (result.code === 0 && result.signal === null) {
        return null;
      }

      if (result.signal !== null) {
        return {
          kind: "signal",
          exitCode: null,
          signalName: result.signal,
          stage,
        };
      }

      return {
        kind: "exit",
        exitCode: result.code as number,
        signalName: null,
        stage,
      };
    });
    return this.cached;
  }
}

/** Single-line human-readable description suitable for embedding in a failure block. */
export function formatProcessExitFailure(
  failure: ProcessExitFailure,
): string {
  const stageDesc = describeStage(failure.stage);
  if (failure.kind === "exit") {
    return `exited with code ${failure.exitCode} ${stageDesc}`;
  }
  return `killed by signal ${failure.signalName} ${stageDesc}`;
}

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
