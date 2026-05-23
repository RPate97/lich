/**
 * Owned-service supervisor — single-process spawn primitive (Plan 1 Task 9).
 *
 * Spawns ONE owned host process (the user's `cmd:` from `lich.yaml`) with the
 * resolved env, tees its stdout+stderr to a per-service log file, and returns
 * a handle the orchestrator can use to wait for exit or stop the process
 * gracefully.
 *
 * Scope:
 *   - **Single-port shape only.** If `portEnvVar` is set, the allocated `port`
 *     is injected into the env as `<portEnvVar>=<port>`. The multi-port shape
 *     (`ports: { ... }`), `oneshot: true`, and custom `stop_cmd:` are
 *     deferred to Task 10 (LEV-277).
 *   - **One service at a time.** Higher-level orchestration (start all owned
 *     services, respect `depends_on`) is Task 23 (the `lich up` integration).
 *     This module is intentionally focused so the spawn/exit/stop primitive
 *     is easy to test and reason about.
 *
 * Design notes:
 *   - We use `child_process.spawn('/bin/sh', ['-c', cmd])` rather than the v0
 *     `concurrently` dependency. Concurrently is great for fan-out with a
 *     prefix-formatted shared terminal, but for a single-service supervisor
 *     it adds a layer of indirection (and an extra dep) we don't need. Raw
 *     `spawn` gives us direct access to pid, exit, stdout/stderr streams.
 *   - We listen for the `'exit'` event, not `'close'`. `'exit'` fires when
 *     the child terminates; `'close'` fires later when the child's stdio
 *     pipes have been fully consumed. The orchestrator wants to know the
 *     moment the process is gone — log-tail flushing can race independently.
 *   - Log writes are best-effort. We open the log file for append (so
 *     concurrent stop/start cycles don't truncate prior content), pipe both
 *     stdout and stderr into it without distinguishing streams (Plan 4 may
 *     add a stream tag), and ignore EPIPE / file-handle errors during late
 *     writes — a failed log write must never crash the supervisor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

/** Spec for one owned service the supervisor will spawn. */
export interface OwnedServiceSpec {
  /** Service name from `lich.yaml` `owned.<name>`. Used in error messages only. */
  name: string;
  /**
   * Shell command to run. May include args, pipes, redirections — anything
   * `/bin/sh -c` can parse. The user's `cmd:` field is passed through verbatim.
   */
  cmd: string;
  /** Working directory; the orchestrator passes the worktree root by default. */
  cwd: string;
  /**
   * Resolved env to inject. Already merged by the env pipeline (top-level
   * `env`, `env_files`, `env_from`, per-service overrides, interpolation).
   * Process inheritance is the orchestrator's call — pass `process.env` in
   * if desired, or pass a curated map.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Single-port shape: the env-var name the allocated port should be exposed
   * as. Together with `port`, the supervisor sets `<portEnvVar>=<port>` in
   * the spawned env. Either both are set or neither — a port without an env
   * name to bind it to would be silently dropped.
   */
  portEnvVar?: string;
  /**
   * Allocated host port (assigned by the port allocator). Injected into the
   * env under `portEnvVar` if both are present.
   */
  port?: number;
  /**
   * Absolute path to the per-service log file. Sourced from
   * `state.serviceLogPath(stackId, name)`. The supervisor opens it for
   * append; the orchestrator is responsible for ensuring the parent
   * directory exists (via `ensureStackDir`).
   */
  logPath: string;
}

/** Result of awaiting a process's exit. */
export interface ExitResult {
  /** Exit code; `null` if the process was killed by a signal. */
  code: number | null;
  /** Signal name if the process was killed by signal; `null` otherwise. */
  signal: NodeJS.Signals | null;
}

/** Handle returned by `startOwnedService`. */
export interface OwnedHandle {
  /** Service name, echoed back for logging convenience. */
  name: string;
  /** PID assigned by the OS at spawn. Stable for the process's lifetime. */
  pid: number;
  /**
   * Resolves when the child fires `'exit'`. Carries the exit code/signal.
   * Never rejects — even spawn failures resolve with `{ code: 1, signal: null }`
   * via the `'error'` listener.
   */
  exited: Promise<ExitResult>;
  /**
   * Send `SIGTERM` to the child, wait up to `graceMs` for graceful exit,
   * then escalate to `SIGKILL` if still alive. Idempotent: calling `stop()`
   * on an already-exited process resolves immediately without sending
   * signals.
   */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Default grace period before SIGKILL escalation. Five seconds is generous
 * enough for most dev servers (Next.js, Express, Vite) to flush logs and
 * close sockets; shorter values risk truncating useful output.
 */
const DEFAULT_GRACE_MS = 5_000;

/**
 * Spawn one owned service.
 *
 * Throws synchronously only for argument-validation issues (which currently
 * are none — the spec is permissive). Spawn failures (binary not found,
 * cwd doesn't exist) surface as `'error'` events from the child, which we
 * translate into an `exited` resolution with code 1; the caller awaits
 * `exited` to learn about them. We do NOT throw asynchronously from this
 * function — every failure path is observable via the handle.
 */
export async function startOwnedService(
  spec: OwnedServiceSpec,
): Promise<OwnedHandle> {
  // Layer the port injection on top of the caller's env. The caller's env
  // already represents the full resolved env pipeline; we only add the
  // port binding here because it's the one piece the supervisor owns.
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    ...(spec.portEnvVar && spec.port !== undefined
      ? { [spec.portEnvVar]: String(spec.port) }
      : {}),
  };

  const child: ChildProcess = spawn("/bin/sh", ["-c", spec.cmd], {
    cwd: spec.cwd,
    env,
    // Ignore stdin (owned services don't read from the user); pipe both
    // stdout and stderr so we can tee them into the log file.
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Open the log file for APPEND, not truncate. This preserves output from
  // previous runs of the same service in the same stack — useful when the
  // user is restarting a flaky service and wants the history.
  const logStream: WriteStream = createWriteStream(spec.logPath, {
    flags: "a",
  });
  // Swallow log-write errors. A failed log write (disk full, fd closed
  // during teardown) must never propagate out as an unhandled error; the
  // process is the source of truth, the log is best-effort observability.
  logStream.on("error", () => {
    /* best-effort */
  });

  // Pipe both streams into the log. We don't tag stdout vs stderr in the
  // file — Plan 4 may add that. Using `pipe()` lets the WriteStream handle
  // backpressure correctly.
  if (child.stdout) {
    child.stdout.pipe(logStream, { end: false });
    child.stdout.on("error", () => {
      /* best-effort */
    });
  }
  if (child.stderr) {
    child.stderr.pipe(logStream, { end: false });
    child.stderr.on("error", () => {
      /* best-effort */
    });
  }

  // Track exit state so `stop()` can short-circuit and the `exited` promise
  // can be awaited multiple times safely (the underlying event fires once).
  let exitResult: ExitResult | null = null;
  let resolveExited!: (r: ExitResult) => void;
  const exited = new Promise<ExitResult>((resolve) => {
    resolveExited = resolve;
  });

  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (exitResult !== null) return;
    exitResult = { code, signal };
    // Close the log stream once the child is gone — no more data is coming.
    // We don't `end()` it on the pipes (we used `end: false`) so we own the
    // close. Errors here are also best-effort.
    logStream.end();
    resolveExited(exitResult);
  };
  child.once("exit", onExit);
  // Spawn-pre-fork failures (ENOENT for the binary, bad cwd) fire 'error'
  // instead of 'exit'. Translate to a synthetic non-zero exit so callers
  // have one path to await.
  child.once("error", () => {
    if (exitResult !== null) return;
    onExit(1, null);
  });

  if (typeof child.pid !== "number") {
    // The pid is normally available synchronously after spawn returns. The
    // only realistic way it's missing is a pre-fork failure — in which case
    // the 'error' listener above will resolve `exited` shortly. Surface a
    // sentinel pid so the handle shape stays uniform.
    return {
      name: spec.name,
      pid: Number.NaN,
      exited,
      stop: async () => {
        // No pid to signal; just wait for the synthetic exit to land.
        await exited;
      },
    };
  }

  const pid = child.pid;

  const stop = async (graceMs: number = DEFAULT_GRACE_MS): Promise<void> => {
    // Idempotent: already exited → nothing to do.
    if (exitResult !== null) return;

    // SIGTERM gives the process a chance to clean up (trap handlers, flush
    // buffers, close sockets). Most dev servers handle this within a few ms.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH (no such process) means the child already died between our
      // exitResult check and the kill — treat as already-stopped.
      await exited;
      return;
    }

    // Race the graceful exit against the grace timeout.
    const graceful = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
    ]);

    if (graceful === "exited") return;

    // Process ignored SIGTERM (or is genuinely stuck). Escalate to SIGKILL,
    // which is uncatchable. Then wait for the exit event to fire — even
    // SIGKILL'd processes emit 'exit'.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone between the timeout and the kill.
    }
    await exited;
  };

  return {
    name: spec.name,
    pid,
    exited,
    stop,
  };
}
