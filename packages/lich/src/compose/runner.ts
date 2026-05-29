/**
 * CLI-agnostic compose runner. Wraps `<cli.cmd> <cli.args...> -p <project>
 * -f <file>... <subcommand>` with typed `up`/`down`/`ps`/`logs` helpers.
 *
 * All argv is constructed programmatically and handed to `execFile` (NOT a
 * shell) so user values can never be re-parsed as shell syntax. Helpers
 * return captured `{ exitCode, stdout, stderr }` regardless of exit status —
 * the runner never throws on non-zero (compose returns non-zero for plenty
 * of expected conditions, e.g. `ps` when no resources exist; caller decides
 * what's fatal). Services come last in argv (compose convention) so flags
 * can't be eaten as service names.
 */

import { execFile } from "node:child_process";
import type { ComposeCli } from "./detect.js";

export interface RunnerCtx {
  cli: ComposeCli;
  /** Compose project name. Convention: `lich-<worktree.name>-<stack_id_short>`. */
  project: string;
  /** Files passed via `-f`, typically `[<base.yml>, <override.yml>]`. */
  files: string[];
  /** Working directory for the spawned compose process. Usually the worktree root. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exec function seam — tests record argv without invoking compose. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * Real `ExecFn`. `execFile` so binary path and args aren't shell-interpreted.
 * Captures stdout/stderr in full; resolves with exit code (never rejects on
 * non-zero exit). 50 MB buffer — compose can spew a lot on cold image pulls.
 */
const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: 50 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // Default encoding returns strings; defensive coercion tolerates
        // Buffer in case the binding is invoked with a different encoding.
        const stdoutAny = stdout as unknown;
        const stderrAny = stderr as unknown;
        const out =
          typeof stdoutAny === "string"
            ? stdoutAny
            : (stdoutAny as { toString(): string }).toString();
        const errOut =
          typeof stderrAny === "string"
            ? stderrAny
            : (stderrAny as { toString(): string }).toString();
        if (err) {
          // Distinguish "process exited non-zero" (resolve with code) from
          // "failed to spawn / was signaled" (reject — caller can't proceed).
          const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof exitCode === "number") {
            resolve({ exitCode, stdout: out, stderr: errOut });
            return;
          }
          reject(err);
          return;
        }
        resolve({ exitCode: 0, stdout: out, stderr: errOut });
      },
    );
  });

/** Indirection seam for tests. */
export const _exec: { current: ExecFn } = { current: realExec };

/**
 * Common prefix argv: `<cli-leading-args> -p <project> -f <file>...`. Files
 * are passed as `-f <file>` pairs (compose treats only the immediately-following
 * token as the file path; chained `-f` is the documented multi-file form).
 */
function baseArgs(ctx: RunnerCtx): string[] {
  const args: string[] = [...ctx.cli.args, "-p", ctx.project];
  for (const f of ctx.files) {
    args.push("-f", f);
  }
  return args;
}

function runSub(ctx: RunnerCtx, subArgs: string[]): Promise<RunResult> {
  return _exec.current(ctx.cli.cmd, [...baseArgs(ctx), ...subArgs], {
    cwd: ctx.cwd,
    env: ctx.env,
  });
}

/**
 * `up [--detach] [services...]`. Defaults to detach — lich is a supervisor
 * and wants compose to background services so we can proceed to start owned
 * services / evaluate ready conditions / run lifecycle hooks.
 */
export function up(
  ctx: RunnerCtx,
  opts: { detach?: boolean; services?: string[] } = {},
): Promise<RunResult> {
  const subArgs: string[] = ["up"];
  if (opts.detach ?? true) subArgs.push("--detach");
  if (opts.services && opts.services.length > 0) {
    subArgs.push(...opts.services);
  }
  return runSub(ctx, subArgs);
}

/**
 * `down [-v] [--remove-orphans]`. `volumes` is destructive; default off so
 * user data (e.g. postgres data dir) survives. `remove_orphans` cleans
 * containers from older compose configs of the same project that aren't in
 * the current files — prevents zombies from previous runs.
 */
export function down(
  ctx: RunnerCtx,
  opts: { volumes?: boolean; remove_orphans?: boolean } = {},
): Promise<RunResult> {
  const subArgs: string[] = ["down"];
  if (opts.volumes) subArgs.push("-v");
  if (opts.remove_orphans) subArgs.push("--remove-orphans");
  return runSub(ctx, subArgs);
}

export function ps(ctx: RunnerCtx): Promise<RunResult> {
  return runSub(ctx, ["ps"]);
}

/**
 * `logs [--follow] [--tail N] [services...]`. `follow` is long-lived — caller
 * cancels via process kill. `tail` limits the initial buffer to last N lines.
 */
export function logs(
  ctx: RunnerCtx,
  opts: { follow?: boolean; tail?: number; services?: string[] } = {},
): Promise<RunResult> {
  const subArgs: string[] = ["logs"];
  if (opts.follow) subArgs.push("--follow");
  if (typeof opts.tail === "number") {
    subArgs.push("--tail", String(opts.tail));
  }
  if (opts.services && opts.services.length > 0) {
    subArgs.push(...opts.services);
  }
  return runSub(ctx, subArgs);
}
