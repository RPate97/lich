/**
 * Per-service lifecycle hook executor.
 *
 * Runs ordered entries from a single service's `lifecycle.<phase>` block,
 * where `<phase>` is one of:
 *
 *   - `before_start`: runs BEFORE the service is started (compose up / owned
 *     spawn). A non-zero exit aborts startup; the executor throws
 *     `PerServiceLifecycleError`.
 *   - `after_ready`: runs AFTER the service's `ready_when` probe passes. A
 *     non-zero exit marks the service failed; the executor throws
 *     `PerServiceLifecycleError`. The hook gates the service's transition to
 *     "ready" — downstream `depends_on` waits for `after_ready` to complete,
 *     not just for the readiness probe (wired up by the startup sequencer in
 *     a later task).
 *   - `before_down`: runs BEFORE the service is stopped. Failures are
 *     reported via the optional `onWarning` callback; execution continues
 *     with the next entry. Teardown is best-effort.
 *
 * Each entry follows the same shape as top-level lifecycle entries:
 *   - shorthand string `"some sh command"`, OR
 *   - long-form `{ cmd: string, env_group?: string }`.
 *
 * Each command is spawned via `/bin/sh -c <cmd>` with the supplied cwd and
 * env. Long-form entries that reference an `env_group` resolve their env via
 * `resolveEnvGroup(name)`. Plan 1 does not implement env_groups; if an entry
 * sets `env_group` and no `resolveEnvGroup` is supplied, the executor throws
 * immediately with a clear message.
 *
 * Implementation note: the spawn + stderr-ring-buffer logic is duplicated
 * from `lifecycle/executor.ts` rather than imported, so this module stays
 * self-contained. The two executors have different error types and different
 * surfaces; sharing a private helper isn't worth the coupling at this stage.
 */

import { spawn } from "node:child_process";

export type PerServicePhase = "before_start" | "after_ready" | "before_down";

export type LifecycleEntry =
  | string
  | { cmd: string; env_group?: string };

export interface RunPerServiceLifecycleInput {
  /** The service whose lifecycle is being run. Used in error messages and warnings. */
  serviceName: string;
  /** Which phase is running. */
  phase: PerServicePhase;
  /** Ordered entries to execute. */
  entries: LifecycleEntry[];
  /** Working directory for spawned commands; typically the worktree root. */
  cwd: string;
  /** Default env passed to spawned commands. */
  env: NodeJS.ProcessEnv;
  /**
   * Resolver for long-form entries with env_group. Plan 1 doesn't implement
   * env_groups (that's Plan 2). For Plan 1 callers should pass undefined; the
   * executor will throw if it encounters a long-form entry with env_group set.
   */
  resolveEnvGroup?: (name: string) => Promise<NodeJS.ProcessEnv>;
}

export interface PerServiceLifecycleWarning {
  serviceName: string;
  phase: PerServicePhase;
  index: number;
  cmd: string;
  exitCode: number;
  stderr: string;
}

export class PerServiceLifecycleError extends Error {
  /** The service whose hook failed. */
  readonly serviceName: string;
  /** Which phase failed. */
  readonly phase: PerServicePhase;
  /** Zero-based index of the offending entry within the phase. */
  readonly index: number;
  /** The command that failed. */
  readonly cmd: string;
  /** Exit code (non-zero). */
  readonly exitCode: number;
  /** Captured stderr (last N bytes). */
  readonly stderr: string;

  constructor(args: {
    serviceName: string;
    phase: PerServicePhase;
    index: number;
    cmd: string;
    exitCode: number;
    stderr: string;
  }) {
    super(
      `service "${args.serviceName}" lifecycle ${args.phase} entry #${args.index} ` +
        `failed (exit ${args.exitCode}): ${args.cmd}`,
    );
    this.name = "PerServiceLifecycleError";
    this.serviceName = args.serviceName;
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
 * Run all entries for the given per-service phase IN ORDER.
 *
 * Behavior by phase:
 *   - `before_start` / `after_ready`: throws `PerServiceLifecycleError` on
 *     the first non-zero exit. Subsequent entries are NOT run.
 *   - `before_down`: failures are reported via the optional `onWarning`
 *     callback; execution continues with the next entry. Never throws on
 *     non-zero exit (still throws on spawn errors from `child_process`).
 */
export async function runPerServiceLifecycle(
  input: RunPerServiceLifecycleInput,
  onWarning?: (warning: PerServiceLifecycleWarning) => void,
): Promise<void> {
  const { serviceName, phase, entries, cwd, env, resolveEnvGroup } = input;
  const bestEffort = phase === "before_down";

  for (let index = 0; index < entries.length; index++) {
    const { cmd, envGroup } = normalize(entries[index]!);

    let entryEnv: NodeJS.ProcessEnv;
    if (envGroup !== undefined) {
      if (!resolveEnvGroup) {
        throw new Error(
          `service "${serviceName}" lifecycle ${phase} entry #${index} ` +
            `references env_group "${envGroup}": ` +
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
          serviceName,
          phase,
          index,
          cmd,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
        continue;
      }
      throw new PerServiceLifecycleError({
        serviceName,
        phase,
        index,
        cmd,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  }
}
