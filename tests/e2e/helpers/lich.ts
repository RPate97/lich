import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Portable across Bun and Node/vitest. See helpers/tmpdir.ts for the
// rationale — previously this used the Bun-only `import.meta.dir`.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LICH_BINARY = resolve(repoRoot, "packages/lich/dist/lich");

export interface RunLichResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunLichOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Default env for every `runLich`/`spawnLich` invocation. Tests can
 * override any of these by passing the same keys in `opts.env`.
 *
 * - `LICH_NO_BROWSER: "1"` — disables the `lich up` browser-auto-open
 *   side effect (LEV-411). Test runs don't want Chrome popping up
 *   between tests; this is equivalent to passing `--no-browser` on
 *   every `lich up` invocation but happens uniformly without per-test
 *   plumbing. Caller can override (`opts.env.LICH_NO_BROWSER = "0"`)
 *   to opt back in for a specific test.
 */
const DEFAULT_TEST_ENV = {
  LICH_NO_BROWSER: "1",
};

/**
 * Run the lich binary synchronously and capture output.
 * Used for short-lived commands like --version, validate, init.
 */
export function runLich(args: string[], opts: RunLichOptions): RunLichResult {
  const result = spawnSync(LICH_BINARY, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...DEFAULT_TEST_ENV, ...opts.env },
    timeout: opts.timeout ?? 30_000,
    encoding: "utf8",
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Spawn the lich binary asynchronously (returns the child process).
 * Used for long-lived commands like `lich up` where the test needs to
 * monitor logs and tear down explicitly.
 */
export function spawnLich(
  args: string[],
  opts: RunLichOptions
): ChildProcess {
  return spawn(LICH_BINARY, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...DEFAULT_TEST_ENV, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
