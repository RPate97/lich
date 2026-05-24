/**
 * Owned-service supervisor — single-process spawn primitive (Plan 1 Tasks 9/10).
 *
 * Spawns ONE owned host process (the user's `cmd:` from `lich.yaml`) with the
 * resolved env, tees its stdout+stderr to a per-service log file, and returns
 * a handle the orchestrator can use to wait for exit or stop the process
 * gracefully.
 *
 * Scope:
 *   - **Single-port AND multi-port** shapes. If `portEnvVar` is set the
 *     allocated `port` is injected as `<portEnvVar>=<port>`. If `ports` is
 *     set, every entry `{name: {envVar, port}}` is injected as
 *     `<envVar>=<port>`. The two shapes are mutually exclusive — setting
 *     both is a config error.
 *   - **`oneshot: true`** for cmds that do setup and exit (e.g. `supabase
 *     start`, seed scripts). The supervisor still returns an `OwnedHandle`
 *     so the higher-level orchestrator can `await handle.exited`; the
 *     convenience `runOneshot` wrapper turns that into a throw-on-nonzero
 *     promise for callers that just want "ran successfully or not."
 *   - **`stopCmd`** — when present, `stop()` runs the provided shell command
 *     instead of sending SIGTERM/SIGKILL. Used by self-managing tools (e.g.
 *     supabase CLI's `supabase stop`) whose teardown does more than killing
 *     the parent pid. The original child PID may have already exited (the
 *     oneshot case) — `stopCmd` runs anyway with the same cwd+env.
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
import { createWriteStream, realpathSync, type WriteStream } from "node:fs";

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
   *
   * Mutually exclusive with `ports`.
   */
  portEnvVar?: string;
  /**
   * Allocated host port (assigned by the port allocator). Injected into the
   * env under `portEnvVar` if both are present.
   */
  port?: number;
  /**
   * Multi-port shape: a map of logical port name → `{envVar, port}`. Each
   * entry is injected into the spawned env as `<envVar>=<port>`. Used by
   * services that need more than one allocated host port (e.g. the supabase
   * CLI exposes api/db/studio/pooler/etc. on separate ports).
   *
   * Mutually exclusive with `portEnvVar`/`port` — setting both throws.
   */
  ports?: Record<string, { envVar: string; port: number }>;
  /**
   * Oneshot mode: the command is expected to do setup and exit on its own
   * (e.g. `supabase start`, a migrations runner). The supervisor still
   * spawns it and returns a handle the same way as a long-lived service;
   * the difference is semantic — the orchestrator should `await
   * handle.exited` before considering the service "started," and treat a
   * non-zero exit as a startup failure. `runOneshot` is the convenience
   * wrapper for that pattern.
   *
   * The supervisor itself doesn't gate behavior on this flag — it's a hint
   * for the caller. We expose it on the spec so the runtime can later
   * decide e.g. whether to keep the service in the supervised set (no, for
   * oneshots: once they exit they're done) without re-plumbing the config.
   */
  oneshot?: boolean;
  /**
   * Custom teardown command. When set, `stop()` runs this shell command
   * instead of sending SIGTERM→SIGKILL to the original child PID. The
   * command is spawned via `/bin/sh -c` with the same `cwd` and `env` as
   * the original spawn (port injections and all), so the teardown can
   * reach the same per-stack resources the start did.
   *
   * Used by self-managing tools whose teardown is more involved than
   * killing a parent pid. Example: `supabase stop` shuts down the
   * background Docker containers `supabase start` spawned.
   */
  stopCmd?: string;
  /**
   * Absolute path to the per-service log file. Sourced from
   * `state.serviceLogPath(stackId, name)`. The supervisor opens it for
   * append; the orchestrator is responsible for ensuring the parent
   * directory exists (via `ensureStackDir`).
   */
  logPath: string;
  /**
   * Optional cancellation signal. Currently consumed by `runOneshot` only —
   * if it fires while the oneshot is still running, the supervisor calls
   * `handle.stop()` (SIGTERM→SIGKILL escalation) and the wrapper throws an
   * "aborted" error so callers can propagate cancellation up the stack.
   *
   * `startOwnedService` itself doesn't react to this signal for long-lived
   * services; the orchestrator already tracks those handles and stops them
   * directly through its own cancellation path.
   */
  signal?: AbortSignal;
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
   *
   * After `stop()` resolves, inspect {@link stopWarning} — when non-null
   * it carries a diagnostic about a teardown lich could not verify (e.g.
   * SIGKILL was sent but the pid still answers `kill(pid, 0)` after a
   * brief post-kill grace). On the common happy path `stopWarning` is
   * null. The promise itself never rejects.
   */
  stop(graceMs?: number): Promise<void>;
  /**
   * Diagnostic populated by the most recent {@link stop} call when lich
   * could not verify the process is actually gone. `null` until a stop()
   * runs, and after a successful-and-verified stop. Used by callers
   * (e.g. `lich up`'s cancellation cleanup) to surface "we sent SIGKILL
   * but the pid still answers" as a user-visible warning instead of
   * silently pretending success.
   */
  readonly stopWarning: string | null;
}

/**
 * Default grace period before SIGKILL escalation. Five seconds is generous
 * enough for most dev servers (Next.js, Express, Vite) to flush logs and
 * close sockets; shorter values risk truncating useful output.
 */
const DEFAULT_GRACE_MS = 5_000;

/**
 * Cap on how long we'll wait for a `stop_cmd` to do its thing. Supabase's
 * `supabase stop` can take >10s on a cold cache; 30s is generous enough
 * for the realistic cases while bounding pathological stalls.
 */
const STOP_CMD_TIMEOUT_MS = 30_000;

/**
 * How many bytes of the oneshot's combined output to include in the
 * thrown error on failure. Enough to capture a typical stack trace or
 * shell error line; not so much that the message becomes useless.
 */
const ONESHOT_TAIL_BYTES = 2_048;

/**
 * Grace window between sending SIGKILL and re-checking liveness. The
 * kernel needs a moment to reap the process and unregister the pid;
 * polling immediately after `process.kill(pid, 'SIGKILL')` would race
 * the reaper and incorrectly report "still alive." 500ms is comfortably
 * longer than the reap latency on any sane Unix while still being
 * imperceptible from a user's perspective. We're only here in the
 * pathological "SIGTERM was ignored" path, so an extra half-second is
 * fine.
 */
const SIGKILL_VERIFY_GRACE_MS = 500;

/** Standard "is this pid alive?" probe via signal 0. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Is any process in the process group `pid` alive?" — uses signal 0 sent
 * to the negative pid (POSIX semantics: kill(-pgid, sig) signals every
 * member of the group with pgid). ESRCH means the group is empty (every
 * member is dead AND reaped). Anything else means at least one member is
 * still alive. We use this to verify a group-kill actually reaped every
 * descendant, not just the leader. See LEV-319.
 */
function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a signal to every process in the process group whose PGID is `pid`.
 * Negative pid is the POSIX convention for "this is a pgid, fan out to
 * every member." Requires the child to have been spawned with
 * `detached: true` so it became a group leader (PGID == its own PID).
 *
 * ESRCH ("no such process") is silently swallowed — the group is already
 * gone, which is the desired end-state. Other errors propagate.
 *
 * Why this exists: the supervisor's child is `/bin/sh -c <user-cmd>`, and
 * the user-cmd typically spawns its own grandchildren (`bun run dev`
 * spawns Express; `npm run dev` spawns a webpack server; etc.). If we
 * SIGTERM just the leader PID, the leader exits but the grandchildren get
 * reparented to init and keep running — port still bound, supabase
 * connection still open, ghost process for every test run. Signaling the
 * whole group catches every descendant. See LEV-319.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw err;
  }
}

/** Promise-based sleep — used for short grace windows. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the canonical-case real path for `cwd` so it can be injected as
 * `PWD` into the spawned child's env.
 *
 * Why this exists: on macOS with case-insensitive APFS, if the user enters
 * the worktree via a wrong-case prefix (`cd /users/ryan/...` instead of
 * `cd /Users/ryan/...`), `process.cwd()` faithfully reports the lowercase
 * form they typed. The kernel doesn't care — both resolve to the same
 * inode — but any downstream tool that does case-sensitive string matching
 * on paths breaks. The motivating example is Docker Desktop's shared-folder
 * enforcement: its `FilesharingDirectories` list contains `/Users` (capital);
 * a bind-mount request with `/users` is rejected ("path is not shared from
 * the host"). The supabase CLI (Go) builds its bind-mount path from `$PWD`,
 * inheriting the lowercase form from the user's shell, and supabase start
 * fails. See LEV-300.
 *
 * The fix layers two pieces of canonicalization, both deliberate:
 *
 *   1. `realpathSync.native` (libc's `realpath(3)`) — this resolves symlinks
 *      AND canonicalizes case on macOS. The JS-only `realpathSync` does NOT
 *      canonicalize case here; it returns whatever case the input had. We
 *      need the native variant specifically.
 *
 *   2. Best-effort with the original `cwd` as fallback. If `cwd` doesn't
 *      exist yet (which is rare but possible — e.g. a future hook that
 *      pre-creates it on the way down to spawn), we still want to spawn
 *      and let the child's own error reporting surface the issue, rather
 *      than throwing here. The lowercase-PWD bug is still a bug in that
 *      case, but it's strictly less bad than failing the spawn for a
 *      missing dir we'd have happily passed through before this fix.
 *
 * Returns the canonical-case absolute path the child should see as `$PWD`.
 */
function canonicalizePwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

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
  // Multi-port and single-port are mutually exclusive. Catching this here
  // (rather than at config-validate time) belt-and-braces the runtime —
  // even if a future code path constructs a spec programmatically, the
  // supervisor refuses to silently pick one over the other.
  if (
    spec.ports !== undefined &&
    (spec.portEnvVar !== undefined || spec.port !== undefined)
  ) {
    throw new Error(
      `owned service "${spec.name}": cannot set both single-port (portEnvVar/port) and multi-port (ports) on the same service`,
    );
  }

  // Layer the port injection(s) on top of the caller's env. The caller's
  // env already represents the full resolved env pipeline; we only add the
  // port binding(s) here because it's the one piece the supervisor owns.
  //
  // We also overwrite `PWD` with the canonical-case realpath of `cwd` (see
  // `canonicalizePwd` above for the LEV-300 rationale). This last write is
  // intentionally placed AFTER `spec.env` so a user-supplied PWD in the
  // resolved env can't accidentally re-introduce a wrong-case path.
  const portEnv: NodeJS.ProcessEnv = {};
  if (spec.portEnvVar && spec.port !== undefined) {
    portEnv[spec.portEnvVar] = String(spec.port);
  }
  if (spec.ports) {
    for (const { envVar, port } of Object.values(spec.ports)) {
      portEnv[envVar] = String(port);
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    ...portEnv,
    PWD: canonicalizePwd(spec.cwd),
  };

  const child: ChildProcess = spawn("/bin/sh", ["-c", spec.cmd], {
    cwd: spec.cwd,
    env,
    // Ignore stdin (owned services don't read from the user); pipe both
    // stdout and stderr so we can tee them into the log file.
    stdio: ["ignore", "pipe", "pipe"],
    // `detached: true` makes the child a process group leader (its PGID
    // equals its own PID), so on stop() we can signal the whole group
    // via `kill(-pid, sig)` and reach every descendant the user's cmd
    // spawned (e.g. `bun run dev` → actual Express server). Without
    // this, SIGTERM kills the leader but its grandchildren get
    // orphaned and keep running. See LEV-319.
    //
    // Note: we deliberately do NOT call child.unref() — we want node to
    // keep tracking the child (stdio, exit events) for the supervisor's
    // lifetime. detached only affects process-group semantics here.
    detached: true,
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
    const noPidHandle: OwnedHandle = {
      name: spec.name,
      pid: Number.NaN,
      exited,
      stopWarning: null,
      stop: async (): Promise<void> => {
        // No pid to signal — but a stopCmd may still need to run (e.g. the
        // child failed to spawn but the service had a teardown side-effect
        // from a prior run). Best-effort; ignore failures.
        if (spec.stopCmd) {
          await runStopCmd(spec, STOP_CMD_TIMEOUT_MS).catch(() => {});
        }
        await exited;
      },
    };
    return noPidHandle;
  }

  const pid = child.pid;

  // Backing store for the handle's `stopWarning` getter. Mutated only from
  // inside stop(); exposed read-only on the handle so the latest verification
  // result is observable after the promise resolves.
  let lastStopWarning: string | null = null;

  const stop = async (
    graceMs: number = DEFAULT_GRACE_MS,
  ): Promise<void> => {
    // Reset on each call. A previous stop() may have left a warning; a
    // fresh attempt (e.g. caller retried) starts from a clean slate.
    lastStopWarning = null;

    // Custom teardown path: run the user-provided shell command instead of
    // signaling the child. This is the supabase pattern — `supabase start`
    // launches Docker containers and exits (oneshot), so SIGTERM to the
    // already-dead CLI process does nothing useful; `supabase stop` is the
    // actual teardown.
    //
    // We still try to send SIGTERM to the original child first if it's
    // alive — some stop_cmd-using services *do* keep a parent process
    // around (e.g. a custom dev script that wraps another tool), and
    // leaking that PID across a stop() call would be a bug. The signal
    // failing (ESRCH) is fine and expected for oneshots.
    if (spec.stopCmd) {
      if (exitResult === null) {
        // Group-signal (LEV-319): catch the leader + any descendants.
        killGroup(pid, "SIGTERM");
      }
      await runStopCmd(spec, STOP_CMD_TIMEOUT_MS);
      // If the original child was still alive, give it a brief moment to
      // notice (it may be a wrapper that watches the same resources the
      // stop_cmd just tore down). If it hasn't exited within the grace
      // window, escalate to SIGKILL so we don't hang forever.
      if (exitResult === null) {
        const graceful = await Promise.race([
          exited.then(() => "exited" as const),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
        ]);
        if (graceful === "timeout") {
          killGroup(pid, "SIGKILL");
          await exited;
        }
      }
      return;
    }

    // Idempotent: already exited → nothing to do.
    if (exitResult !== null) return;

    // SIGTERM the whole process group (LEV-319) — gives the leader AND
    // its descendants (the actual Express server spawned by `bun run dev`,
    // etc.) a chance to clean up. Most dev servers handle SIGTERM within
    // a few ms.
    killGroup(pid, "SIGTERM");

    // Race the leader's graceful exit against the grace timeout. The
    // leader exiting doesn't guarantee descendants are gone — that's
    // what the post-SIGKILL group-alive check below catches.
    const graceful = await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
    ]);

    // Whether or not the leader exited gracefully, escalate to SIGKILL on
    // the group if anyone is still alive. SIGKILL is uncatchable; this is
    // the "we tried polite, now we're going" step.
    if (graceful === "timeout" || isGroupAlive(pid)) {
      killGroup(pid, "SIGKILL");
      // Even when only descendants needed killing (leader already exited),
      // the leader's `exited` promise has already resolved, so this await
      // is a no-op in the happy case.
      await exited;
    }

    // Post-SIGKILL verification (LEV-312 + LEV-319): SIGKILL is uncatchable
    // but the kernel needs a tick or two to reap each process. After a
    // brief grace window we check the WHOLE GROUP via `kill(-pid, 0)` —
    // ESRCH means every group member is dead and reaped (happy path);
    // no error means at least one descendant is still alive, which is the
    // "lich said it killed the thing and it didn't" case. Extremely rare
    // — typically uninterruptible D-state, zombie accounting, or a
    // containerized pid mismatch — but when it does happen the user's
    // "if lich reports success the thing is gone" contract is broken
    // and we should say so. The diagnostic surfaces on the handle's
    // `stopWarning` field for callers to read.
    await sleep(SIGKILL_VERIFY_GRACE_MS);
    if (isGroupAlive(pid)) {
      lastStopWarning = `SIGKILL did not reap process group ${pid} after ${SIGKILL_VERIFY_GRACE_MS}ms; one or more processes may still be alive`;
    }
  };

  const handle: OwnedHandle = {
    name: spec.name,
    pid,
    exited,
    stop,
    get stopWarning() {
      return lastStopWarning;
    },
  };
  return handle;
}

/**
 * Spawn the spec's `stopCmd` via `/bin/sh -c` with the same cwd+env as the
 * original child, tee its output to the same log file, and resolve once it
 * exits (regardless of exit code) or the timeout fires.
 *
 * Non-zero exits are not thrown — the supervisor has no logger to surface
 * a warning through, and the orchestrator's source of truth for "is the
 * service still running?" is the child's `exited` promise plus any
 * higher-level health check, not the stop command's exit code. If the
 * stop_cmd genuinely failed to tear something down, the next `lich up`
 * will surface the leak (port still in use, container still running).
 *
 * The timeout exists to bound pathological hangs (network-attached
 * teardown that's lost connectivity, etc.). When it fires we SIGKILL the
 * stop_cmd's own process and move on.
 */
async function runStopCmd(
  spec: OwnedServiceSpec,
  timeoutMs: number,
): Promise<void> {
  if (!spec.stopCmd) return;

  // Recompute the port-injected env so the stop_cmd sees the same ports as
  // the start cmd did. Cheaper to rebuild than to thread the value through.
  // Includes the same `PWD` canonicalization as the start path so teardown
  // tools (e.g. `supabase stop`) construct bind-mount paths consistent with
  // those the start side used — otherwise docker may fail to locate the
  // resources to stop. See `canonicalizePwd` for the LEV-300 rationale.
  const portEnv: NodeJS.ProcessEnv = {};
  if (spec.portEnvVar && spec.port !== undefined) {
    portEnv[spec.portEnvVar] = String(spec.port);
  }
  if (spec.ports) {
    for (const { envVar, port } of Object.values(spec.ports)) {
      portEnv[envVar] = String(port);
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    ...portEnv,
    PWD: canonicalizePwd(spec.cwd),
  };

  const child = spawn("/bin/sh", ["-c", spec.stopCmd], {
    cwd: spec.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Group leader so the timeout-SIGKILL path can fan out to descendants
    // the stop_cmd may have spawned (e.g. `supabase stop` shells out to
    // docker compose). LEV-319.
    detached: true,
  });

  // Append to the same log file — the teardown's output is part of the
  // service's story, and keeping it inline with the start-time logs makes
  // post-mortems easier.
  const logStream = createWriteStream(spec.logPath, { flags: "a" });
  logStream.on("error", () => {
    /* best-effort */
  });
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

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      logStream.end();
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      // Stop_cmd is taking too long. Hard-kill the whole group and move
      // on (LEV-319). The service's state-of-the-world (containers
      // running, ports bound) is whatever it is; we don't pretend
      // otherwise.
      if (typeof child.pid === "number") {
        killGroup(child.pid, "SIGKILL");
      }
      finish();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Run a oneshot owned service to completion and throw if it exits non-zero.
 *
 * This is the convenience wrapper around `startOwnedService` for callers
 * that want "did this setup step succeed?" semantics — no long-lived
 * handle to track, no separate exit-await step. Use it for things like
 * `supabase start`, seed scripts, one-time fetches, or any cmd marked
 * `oneshot: true` in the user's yaml.
 *
 * On non-zero exit, the rejection message includes:
 *   - the service name
 *   - the exit code (or signal name if signal-killed)
 *   - the tail of the service's log file (up to ONESHOT_TAIL_BYTES)
 *
 * The log-tail inclusion is important: callers won't necessarily look at
 * the log file themselves before re-throwing, and an error message that
 * just says "exit 7" is almost useless for debugging. The tail surfaces
 * the actual stderr/stdout that caused the failure.
 */
export async function runOneshot(spec: OwnedServiceSpec): Promise<void> {
  // If the caller already aborted before we got here, refuse to spawn —
  // the user's Ctrl-C arrived between the prior step and ours; spawning a
  // child just to kill it would leak file handles for no benefit.
  if (spec.signal?.aborted) {
    throw new Error(`oneshot "${spec.name}" aborted before start`);
  }

  const handle = await startOwnedService(spec);

  // Wire the cancellation signal: if it fires while the oneshot is still
  // running, escalate via handle.stop() (SIGTERM→SIGKILL). The handle's
  // `exited` promise will resolve once the process is gone; we then throw
  // an "aborted" error so callers don't mistake the kill for a normal
  // non-zero exit. The `abort` listener is one-shot and is removed in the
  // finally block so we don't leak it across runs.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    // Fire-and-forget: stop() resolves once the child is dead, but we're
    // already awaiting `handle.exited` below. Errors are swallowed because
    // the child may have already exited cleanly between the abort firing
    // and stop() running.
    handle.stop().catch(() => {});
  };

  if (spec.signal) {
    if (spec.signal.aborted) {
      // Lost the race between our pre-spawn check and the actual spawn.
      onAbort();
    } else {
      spec.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let result: ExitResult;
  try {
    result = await handle.exited;
  } finally {
    if (spec.signal) {
      spec.signal.removeEventListener("abort", onAbort);
    }
  }

  if (aborted) {
    throw new Error(`oneshot "${spec.name}" aborted`);
  }

  if (result.code === 0) return;

  // Read the log tail for the error message. Best-effort: if the log
  // file is missing (write failed, etc.) we still throw a useful error
  // with the exit code, just without context.
  let tail = "";
  try {
    const { readFile } = await import("node:fs/promises");
    const contents = await readFile(spec.logPath, "utf8");
    tail =
      contents.length > ONESHOT_TAIL_BYTES
        ? `...${contents.slice(-ONESHOT_TAIL_BYTES)}`
        : contents;
  } catch {
    /* best-effort */
  }

  const exitDesc =
    result.code !== null
      ? `exit code ${result.code}`
      : `signal ${result.signal ?? "unknown"}`;
  const tailSection = tail.trim() ? `\n--- output tail ---\n${tail}` : "";
  throw new Error(
    `oneshot "${spec.name}" failed: ${exitDesc}${tailSection}`,
  );
}
