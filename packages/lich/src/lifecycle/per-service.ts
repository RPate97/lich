/**
 * Per-service lifecycle hook executor. Runs entries from a service's
 * `lifecycle.<before_start|after_ready|before_down>` block. Start/ready
 * failures throw `PerServiceLifecycleError`; `before_down` failures call
 * `onWarning` and continue.
 *
 * `after_ready` gates the service's transition to "ready" — downstream
 * `depends_on` waits for it to complete, not just for `ready_when`.
 */

import { spawn } from "node:child_process";

export type PerServicePhase = "before_start" | "after_ready" | "before_down";

export type LifecycleEntry =
  | string
  | { cmd: string; env_group?: string };

export interface RunPerServiceLifecycleInput {
  serviceName: string;
  phase: PerServicePhase;
  entries: LifecycleEntry[];
  /** Working directory; typically the worktree root. */
  cwd: string;
  /** Default env for spawned commands. */
  env: NodeJS.ProcessEnv;
  /** Resolver for long-form entries with `env_group`. Throws if missing when needed. */
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
  readonly serviceName: string;
  readonly phase: PerServicePhase;
  /** Zero-based index of the offending entry. */
  readonly index: number;
  readonly cmd: string;
  readonly exitCode: number;
  /** Last `STDERR_TAIL_BYTES` of captured stderr. */
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
      // drain — per-service hooks don't surface stdout
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
 * Run entries in order. `before_start`/`after_ready` throw on first non-zero
 * exit; `before_down` calls `onWarning` and continues. Always throws on
 * spawn errors.
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
