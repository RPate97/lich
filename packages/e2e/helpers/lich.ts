import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Portable across Bun and Node/vitest (previously used Bun-only `import.meta.dir`).
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

// Suppresses browser auto-open AND disables telemetry across all tests so
// the suite never pollutes real-user analytics with CI/dev events.
const DEFAULT_TEST_ENV = {
  LICH_NO_BROWSER: "1",
  LICH_TELEMETRY: "0",
};

/** Run the lich binary synchronously and capture output. */
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

/** Spawn the lich binary asynchronously for long-lived commands like `lich up`. */
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
