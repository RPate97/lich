/**
 * cmd ready evaluator. Spawns a shell command at a fixed interval; resolves on
 * exit 0. Non-zero exit / signal exit keeps polling. No outer timeout — callers
 * wrap with `withTimeout`. AbortSignal cancels both the in-flight child and
 * sleep. Spawn errors (`ENOENT` on /bin/sh, etc.) reject immediately rather
 * than retry, since the cmd will never run.
 */

import { spawn } from "node:child_process";

export interface WaitForCmdReadyInput {
  /** Shell command, run as `/bin/sh -c <shellCmd>`. */
  shellCmd: string;
  /** Env vars passed to the spawned shell. */
  env: Record<string, string>;
  /** Working directory for the spawned shell. */
  cwd: string;
  /** Polling interval in ms between attempts. Default 1000. */
  intervalMs?: number;
  /** AbortSignal to cancel the polling loop. On fire, the promise rejects. */
  signal?: AbortSignal;
  /** Optional per-attempt observer for tests / instrumentation. */
  onAttempt?: (attempt: number, exitCode: number | null) => void;
}

const DEFAULT_INTERVAL_MS = 1000;

/** Resolves when the shell cmd exits 0. Rejects on AbortSignal fire or spawn error. */
export async function waitForCmdReady(input: WaitForCmdReadyInput): Promise<void> {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const outerSignal = input.signal;

  if (outerSignal?.aborted) {
    throw new Error("aborted");
  }

  let attempt = 0;
  while (true) {
    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    attempt += 1;
    const exitCode = await runOnce(input.shellCmd, input.cwd, input.env, outerSignal);
    input.onAttempt?.(attempt, exitCode);

    if (exitCode === 0) {
      return;
    }

    if (outerSignal?.aborted) {
      throw new Error("aborted");
    }

    await sleep(intervalMs, outerSignal);
  }
}

/**
 * Spawn `/bin/sh -c <shellCmd>` once and resolve with its exit code (null on
 * signal exit / abort). Spawn errors reject — caller treats them as fatal.
 */
function runOnce(
  shellCmd: string,
  cwd: string,
  env: Record<string, string>,
  outerSignal: AbortSignal | undefined,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", shellCmd], {
        cwd,
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const cleanup = (): void => {
      if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may have already exited
      }
      cleanup();
      reject(new Error("aborted"));
    };

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Spawn errors (`ENOENT` on /bin/sh, EACCES, etc.) are fatal — the cmd
      // will never run, so propagate rather than retry forever.
      reject(
        err instanceof Error
          ? new Error(`ready_when.cmd spawn failed: ${err.message}`)
          : new Error(`ready_when.cmd spawn failed: ${String(err)}`),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal !== null) {
        // Signal exit (e.g. our own SIGTERM on abort) — treat as null exit.
        resolve(null);
        return;
      }
      resolve(code);
    });

    if (outerSignal) {
      if (outerSignal.aborted) {
        onAbort();
        return;
      }
      outerSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
