/**
 * E2E harness — CLI runner.
 *
 * Spawns the `lich` binary as a real subprocess from within the
 * scaffolded project. After `installDeps` runs, `node_modules/.bin/lich`
 * symlinks to the workspace `packages/core/src/bin.ts` (because bun runs
 * `.ts` directly), which is the entry point real users hit when they type
 * `lich ...` in their project directory.
 *
 * We intentionally do NOT import the bin module directly. The whole point
 * of LEV-198 is to catch the wiring bugs that unit tests miss — bin module
 * loading, argv parsing, plugin discovery via `loadConfig`, process-exit
 * semantics — all of which only run when there's a real subprocess
 * boundary.
 *
 * Two helpers live here:
 *   - `runCli` / `runCliJson` (blocking; `spawnSync`) — the canonical
 *     "fire and read the result" path used by every happy-path e2e test.
 *   - `spawnCli` (async; `child_process.spawn`) — for tests that need to
 *     drive a running CLI process (send signals, wait for output, etc.).
 *     LEV-209 added this for the real-SIGINT regression tests; everything
 *     else should stay on the blocking path because it's simpler.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Whether the spawn hit its own timeout (vs. exited normally). */
  timedOut: boolean;
}

export interface CliOptions {
  /** Additional env vars merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Spawn timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Distinct error class so callers (and vitest) can spot a CLI timeout
 * immediately rather than tracking down a stale "invalid JSON" parse error
 * from empty stdout. `runCliJson` throws this when the underlying
 * `runCli` result had `timedOut: true`.
 */
export class CliTimeoutError extends Error {
  readonly result: CliResult;
  constructor(args: string[], timeoutMs: number, result: CliResult) {
    super(
      `lich ${args.join(' ')} timed out after ${timeoutMs}ms\n` +
        `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
    this.name = 'CliTimeoutError';
    this.result = result;
  }
}

/**
 * Run `bun run lich <args>` from within `projectDir`.
 *
 * Why `bun run lich` and not the .bin shim directly: bun's `run`
 * command picks up the project-local `node_modules/.bin/lich` first,
 * matching what a user would see if they typed `bun lich ...`. Also
 * gives us a stable invocation that works whether lich is installed
 * as a local dependency or globally.
 */
export function runCli(
  projectDir: string,
  args: string[],
  opts: CliOptions = {},
): CliResult {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = { ...process.env, ...opts.env };

  // Prefer the local bin if present (post-install path). The fallback
  // `bun run lich …` branch is defensive scaffolding: every e2e code
  // path goes through `installDeps()` first, which materializes
  // `node_modules/.bin/lich` (and asserts on it). If the .bin shim is
  // somehow missing here, we'd rather fall back gracefully than crash on a
  // not-found exec — but in practice this branch is unreachable today.
  const localBin = join(projectDir, 'node_modules', '.bin', 'lich');
  let command: string;
  let spawnArgs: string[];
  if (existsSync(localBin)) {
    command = localBin;
    spawnArgs = args;
  } else {
    // Resolve the workspace bin path through node_modules — bun picks up
    // the `bin` field from the resolved `@lich/core/package.json`.
    command = 'bun';
    spawnArgs = ['run', 'lich', ...args];
  }

  const r: SpawnSyncReturns<string> = spawnSync(command, spawnArgs, {
    cwd: projectDir,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    // `bun run` writes status lines to stderr; capture both streams.
    stdio: 'pipe',
  });

  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.signal === 'SIGTERM' && (r.status === null || r.status === undefined),
  };
}

/**
 * Convenience for the common case where the command is expected to emit
 * JSON on stdout. Parses it and surfaces a clean error if parsing fails.
 */
export function runCliJson<T = unknown>(
  projectDir: string,
  args: string[],
  opts: CliOptions = {},
): { result: CliResult; json: T } {
  const result = runCli(projectDir, args, opts);
  // Surface timeouts as a distinct error class so callers see the actual
  // failure mode loudly. Without this branch, a timed-out spawn returns
  // empty stdout, which then trips the JSON.parse path below — and the
  // resulting "invalid JSON" stack trace points at parsing, not at the
  // missing CLI. CliTimeoutError points the developer straight at the
  // spawn timeout (see I6 in LEV-206).
  if (result.timedOut) {
    throw new CliTimeoutError(args, opts.timeoutMs ?? 60_000, result);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `lich ${args.join(' ')} exited ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
  let json: T;
  try {
    json = JSON.parse(result.stdout) as T;
  } catch (err) {
    // Pass the original SyntaxError through as `cause` so vitest's diff
    // renderer can show the underlying parse error position alongside our
    // wrapping message (M11 in LEV-206).
    throw new Error(
      `lich ${args.join(' ')} did not emit valid JSON: ${(err as Error).message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: err as Error },
    );
  }
  return { result, json };
}

// ---------------------------------------------------------------------------
// Async spawn (LEV-209)
// ---------------------------------------------------------------------------

export interface SpawnCliOptions {
  /** Additional env vars merged on top of `process.env`. */
  env?: Record<string, string>;
}

export interface ExitResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnedCli {
  /** The underlying `ChildProcess`. Exposed so tests can inspect `.pid`. */
  proc: ChildProcess;
  /**
   * Live-mutating arrays of utf8 chunks captured from the child. Tests can
   * either join them at the end (`.join('')`) or hand them to a polling
   * matcher. We expose chunks rather than the joined string so we never
   * have to debounce — every emitted chunk is appended in order.
   */
  stdoutChunks: string[];
  stderrChunks: string[];
  /**
   * Send a signal to the child. Defaults to SIGINT (the case LEV-199 /
   * LEV-203 actually care about). No-op if the child is already gone.
   */
  kill(signal?: NodeJS.Signals): void;
  /**
   * Resolve once the child has exited, OR reject if it doesn't exit
   * within `timeoutMs` (default 30s). The returned `{ exitCode, signal }`
   * pair mirrors the `'exit'` event's args — `signal` is set when the
   * child was killed by a signal (e.g. SIGINT), `exitCode` otherwise.
   */
  waitForExit(timeoutMs?: number): Promise<ExitResult>;
  /**
   * Resolve once the child's stdout has emitted a chunk matching `pattern`.
   * Returns the matched substring (whatever `RegExp#exec` produced as
   * `match[0]`). Useful for waiting until `dev` finishes booting before
   * sending SIGINT — without it the test races the spawn and may signal
   * before the lock is even acquired.
   *
   * Times out after `timeoutMs` (default 30s) with a thrown error whose
   * message includes the buffered stdout/stderr so the failure is
   * diagnosable.
   */
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Same as `waitForStdout` but matches against stderr. */
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
}

/**
 * Spawn `lich <args>` from within `projectDir` as a backgrounded child
 * process. Same binary-resolution rules as `runCli` (prefer the local
 * `.bin/lich` symlink, fall back to `bun run lich`).
 *
 * The returned handle has the live `stdoutChunks` / `stderrChunks` arrays,
 * plus `waitForStdout`/`waitForStderr` matchers and a `kill` helper that
 * defaults to SIGINT. See `SpawnedCli` for the full surface.
 *
 * The child runs detached only insofar as we don't `child.unref()` —
 * vitest's process owns it, and `kill()` is the only path to terminate it.
 * If a test forgets to `kill()` and `waitForExit()`, the worker may hang
 * waiting for the child to drain; the SIGINT-and-wait pattern below is the
 * idiom every caller should follow.
 */
export function spawnCli(
  projectDir: string,
  args: string[],
  opts: SpawnCliOptions = {},
): SpawnedCli {
  const env = { ...process.env, ...opts.env };
  const localBin = join(projectDir, 'node_modules', '.bin', 'lich');
  let command: string;
  let spawnArgs: string[];
  if (existsSync(localBin)) {
    command = localBin;
    spawnArgs = args;
  } else {
    command = 'bun';
    spawnArgs = ['run', 'lich', ...args];
  }

  const proc = spawn(command, spawnArgs, {
    cwd: projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    stdoutChunks.push(chunk);
  });
  proc.stderr?.on('data', (chunk: string) => {
    stderrChunks.push(chunk);
  });

  // Cache the exit info as soon as it lands so `waitForExit` can resolve
  // synchronously even if the caller awaits long after the child died.
  let exitInfo: ExitResult | null = null;
  proc.once('exit', (code, signal) => {
    exitInfo = { exitCode: code, signal };
  });

  const waitForExit = (timeoutMs = 30_000): Promise<ExitResult> => {
    if (exitInfo) return Promise.resolve(exitInfo);
    return new Promise<ExitResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.removeListener('exit', onExit);
        reject(
          new Error(
            `spawnCli: child did not exit within ${timeoutMs}ms (pid ${proc.pid ?? '?'})`,
          ),
        );
      }, timeoutMs);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal });
      };
      proc.once('exit', onExit);
    });
  };

  const waitForMatch = (
    chunks: string[],
    stream: 'stdout' | 'stderr',
    pattern: RegExp,
    timeoutMs: number,
  ): Promise<string> => {
    // Fast path — already buffered before the caller asked.
    const initial = chunks.join('');
    const m0 = pattern.exec(initial);
    if (m0) return Promise.resolve(m0[0]);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        stripListener();
        const buf = chunks.join('').slice(-2000);
        reject(
          new Error(
            `spawnCli.waitFor${stream === 'stdout' ? 'Stdout' : 'Stderr'}: ` +
              `pattern ${pattern} did not match within ${timeoutMs}ms\n` +
              `last ${stream}:\n${buf}\n` +
              `last stderr:\n${stderrChunks.join('').slice(-2000)}`,
          ),
        );
      }, timeoutMs);

      const stripListener = () => {
        const src = stream === 'stdout' ? proc.stdout : proc.stderr;
        src?.removeListener('data', onData);
        proc.removeListener('exit', onExit);
      };

      const onData = () => {
        // Re-join each tick; chunks are typically small. If the child were
        // pathologically chatty (megabytes/sec) we'd want a smarter buffer,
        // but for CLI output the simple form is fine.
        const m = pattern.exec(chunks.join(''));
        if (m) {
          clearTimeout(timer);
          stripListener();
          resolve(m[0]);
        }
      };

      const onExit = () => {
        // Child died before the pattern matched. Drain whatever's buffered
        // one last time, then reject if still no match — there's nothing
        // more coming.
        const m = pattern.exec(chunks.join(''));
        if (m) {
          clearTimeout(timer);
          stripListener();
          resolve(m[0]);
        } else {
          clearTimeout(timer);
          stripListener();
          reject(
            new Error(
              `spawnCli.waitFor${stream === 'stdout' ? 'Stdout' : 'Stderr'}: ` +
                `child exited before pattern ${pattern} matched\n` +
                `${stream}:\n${chunks.join('').slice(-2000)}\n` +
                `stderr:\n${stderrChunks.join('').slice(-2000)}`,
            ),
          );
        }
      };

      const src = stream === 'stdout' ? proc.stdout : proc.stderr;
      src?.on('data', onData);
      proc.once('exit', onExit);
    });
  };

  return {
    proc,
    stdoutChunks,
    stderrChunks,
    kill(signal: NodeJS.Signals = 'SIGINT') {
      if (exitInfo) return;
      try {
        proc.kill(signal);
      } catch {
        /* already dead */
      }
    },
    waitForExit,
    waitForStdout(pattern, timeoutMs = 30_000) {
      return waitForMatch(stdoutChunks, 'stdout', pattern, timeoutMs);
    },
    waitForStderr(pattern, timeoutMs = 30_000) {
      return waitForMatch(stderrChunks, 'stderr', pattern, timeoutMs);
    },
  };
}
