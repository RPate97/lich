/**
 * E2E harness — CLI runner.
 *
 * Spawns the `levelzero` binary as a real subprocess from within the
 * scaffolded project. After `installDeps` runs, `node_modules/.bin/levelzero`
 * symlinks to the workspace `packages/core/src/bin.ts` (because bun runs
 * `.ts` directly), which is the entry point real users hit when they type
 * `levelzero ...` in their project directory.
 *
 * We intentionally do NOT import the bin module directly. The whole point
 * of LEV-198 is to catch the wiring bugs that unit tests miss — bin module
 * loading, argv parsing, plugin discovery via `loadConfig`, process-exit
 * semantics — all of which only run when there's a real subprocess
 * boundary.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
 * Run `bun run levelzero <args>` from within `projectDir`.
 *
 * Why `bun run levelzero` and not the .bin shim directly: bun's `run`
 * command picks up the project-local `node_modules/.bin/levelzero` first,
 * matching what a user would see if they typed `bun levelzero ...`. Also
 * gives us a stable invocation that works whether levelzero is installed
 * as a local dependency or globally.
 */
export function runCli(
  projectDir: string,
  args: string[],
  opts: CliOptions = {},
): CliResult {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = { ...process.env, ...opts.env };

  // Prefer the local bin if present (post-install path). Fall back to bun
  // running the workspace bin file directly — useful in odd cases where
  // the install missed the .bin shim but the package is still on disk.
  const localBin = join(projectDir, 'node_modules', '.bin', 'levelzero');
  let command: string;
  let spawnArgs: string[];
  if (existsSync(localBin)) {
    command = localBin;
    spawnArgs = args;
  } else {
    // Resolve the workspace bin path through node_modules — bun picks up
    // the `bin` field from the resolved `@levelzero/core/package.json`.
    command = 'bun';
    spawnArgs = ['run', 'levelzero', ...args];
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
  if (result.exitCode !== 0) {
    throw new Error(
      `levelzero ${args.join(' ')} exited ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
  let json: T;
  try {
    json = JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(
      `levelzero ${args.join(' ')} did not emit valid JSON: ${(err as Error).message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { result, json };
}
