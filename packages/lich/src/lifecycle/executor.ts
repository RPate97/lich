/**
 * Top-level lifecycle hook executor.
 *
 * Runs ordered entries from `lifecycle.before_up`, `lifecycle.after_up`, or
 * `lifecycle.before_down`. Each entry is either a shorthand shell command
 * string or a long-form `{ cmd, env_group? }` object.
 *
 * Each command is spawned via `/bin/sh -c <cmd>` with the supplied cwd and env
 * (or, for long-form entries that reference an env_group, with the env
 * produced by `resolveEnvGroup(name)` instead).
 *
 * Failure handling differs by phase:
 *   - before_up / after_up: a non-zero exit aborts the phase immediately and
 *     throws `LifecycleHookError`. Subsequent entries are NOT run.
 *   - before_down: a non-zero exit is reported via the optional `onWarning`
 *     callback and the executor continues with the next entry, so teardown is
 *     best-effort.
 *
 * Plan 1 does not implement env_groups (Plan 2 will). If an entry sets
 * `env_group` and no `resolveEnvGroup` is supplied, the executor throws
 * immediately with a clear message.
 */

import { spawn } from "node:child_process";

export type LifecyclePhase = "before_up" | "after_up" | "before_down";

export type LifecycleEntry =
  | string
  | { cmd: string; env_group?: string };

export interface RunLifecycleInput {
  phase: LifecyclePhase;
  entries: LifecycleEntry[];
  /** Working directory; typically the worktree root. */
  cwd: string;
  /** Resolved env for the hook execution. Plan 1: pass the top-level resolved env. */
  env: NodeJS.ProcessEnv;
  /**
   * Resolver for long-form entries with env_group. Plan 1 doesn't implement env_groups
   * (that's Plan 2 / LEV-2xx). For Plan 1 callers should pass undefined here; the
   * executor will throw if it encounters a long-form entry with env_group set.
   */
  resolveEnvGroup?: (name: string) => Promise<NodeJS.ProcessEnv>;
}

export interface LifecycleWarning {
  index: number;
  cmd: string;
  exitCode: number;
  stderr: string;
}

export class LifecycleHookError extends Error {
  /** Which phase failed. */
  readonly phase: LifecyclePhase;
  /** Zero-based index of the offending entry within the phase. */
  readonly index: number;
  /** The command that failed. */
  readonly cmd: string;
  /** Exit code (non-zero). */
  readonly exitCode: number;
  /** Captured stderr (last N bytes). */
  readonly stderr: string;

  constructor(args: {
    phase: LifecyclePhase;
    index: number;
    cmd: string;
    exitCode: number;
    stderr: string;
  }) {
    super(
      `lifecycle ${args.phase} entry #${args.index} failed (exit ${args.exitCode}): ${args.cmd}`,
    );
    this.name = "LifecycleHookError";
    this.phase = args.phase;
    this.index = args.index;
    this.cmd = args.cmd;
    this.exitCode = args.exitCode;
    this.stderr = args.stderr;
  }
}

const STDERR_TAIL_BYTES = 4096;

interface NormalizedEntry {
  cmd: string;
  envGroup: string | undefined;
}

function normalize(entry: LifecycleEntry): NormalizedEntry {
  if (typeof entry === "string") {
    return { cmd: entry, envGroup: undefined };
  }
  return { cmd: entry.cmd, envGroup: entry.env_group };
}

interface SpawnResult {
  exitCode: number;
  stderr: string;
}

// see CLEANUP-HINTS.md: extract when next touched
function runOne(
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";

    child.stdout?.on("data", () => {
      // drain; we don't surface stdout from lifecycle hooks in Plan 1
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail += text;
      if (stderrTail.length > STDERR_TAIL_BYTES) {
        stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_BYTES);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1);
      resolve({ exitCode, stderr: stderrTail });
    });
  });
}

/**
 * Run all entries in `entries` IN ORDER. Each command is spawned via /bin/sh -c
 * with cwd + env (or env-group env if specified for that entry).
 *
 * For before_up / after_up: a non-zero exit aborts immediately and throws
 * LifecycleHookError. The current entry's stderr is included in the error.
 *
 * For before_down: failures are LOGGED via the optional onWarning callback but
 * do NOT throw — teardown should be best-effort. The function returns even if
 * some entries failed.
 */
export async function runLifecycle(
  input: RunLifecycleInput,
  onWarning?: (warning: LifecycleWarning) => void,
): Promise<void> {
  const { phase, entries, cwd, env, resolveEnvGroup } = input;
  const bestEffort = phase === "before_down";

  for (let index = 0; index < entries.length; index++) {
    const { cmd, envGroup } = normalize(entries[index]!);

    let entryEnv: NodeJS.ProcessEnv;
    if (envGroup !== undefined) {
      if (!resolveEnvGroup) {
        throw new Error(
          `lifecycle ${phase} entry #${index} references env_group "${envGroup}": ` +
            `env_group not supported in Plan 1; provide resolveEnvGroup in Plan 2+`,
        );
      }
      entryEnv = await resolveEnvGroup(envGroup);
    } else {
      entryEnv = env;
    }

    const result = await runOne(cmd, cwd, entryEnv);

    if (result.exitCode !== 0) {
      if (bestEffort) {
        onWarning?.({
          index,
          cmd,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
        continue;
      }
      throw new LifecycleHookError({
        phase,
        index,
        cmd,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  }
}
