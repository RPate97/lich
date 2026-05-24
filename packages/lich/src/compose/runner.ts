/**
 * CLI-agnostic compose runner.
 *
 * Wraps `<cli.cmd> <cli.args...> -p <project> -f <file>... <subcommand>`
 * with typed `up`/`down`/`ps`/`logs` helpers. All argv is constructed
 * programmatically and handed to `execFile` (NOT a shell) so user values
 * — project names, file paths, service names — can never be re-parsed
 * as shell syntax.
 *
 * Design notes:
 *
 *   - Every helper returns the captured `{ exitCode, stdout, stderr }`
 *     regardless of exit status. We never throw on non-zero compose
 *     exits — caller decides what is fatal. (Compose returns non-zero
 *     for plenty of expected conditions, e.g. `ps` when no resources
 *     exist; the runner shouldn't editorialize.)
 *
 *   - `up` defaults to `--detach`. Lich is a supervisor: we want compose
 *     to background services and return promptly so the supervisor can
 *     proceed to start owned services / evaluate ready conditions /
 *     run lifecycle hooks. Callers can pass `detach: false` for the
 *     rare cases where attached output is wanted.
 *
 *   - Services come last in argv (per compose convention) so flags
 *     can't be accidentally treated as service names.
 *
 *   - A swappable `_exec.current` seam lets unit tests record argv
 *     without spawning anything.
 */

import { execFile } from "node:child_process";
import type { ComposeCli } from "./detect.js";

export interface RunnerCtx {
  /** Which compose CLI to drive — output of `resolveComposeCli`. */
  cli: ComposeCli;
  /**
   * Compose project name. Uniquely identifies this stack in compose's
   * eyes. Convention (set by callers): `lich-<worktree.name>-<stack_id_short>`.
   */
  project: string;
  /**
   * Files passed via `-f`. Typically `[<lich-managed-base.yml>, <override.yml>]`
   * once Task 8 lands; for Plan 1 the runner happily takes any list,
   * including just the user's `compose_file` paths.
   */
  files: string[];
  /** Working directory for the spawned compose process. Usually the worktree root. */
  cwd: string;
  /** Resolved env for the spawned compose process. */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Shape of the exec function used by the runner. Exists as a seam so
 * tests can record argv (and synthesize results) without invoking the
 * real compose binary.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * Real implementation of `ExecFn`. Uses `execFile` so the binary path
 * and args are not interpreted by a shell. Captures stdout/stderr in
 * full; resolves with the exit code (never rejects on non-zero exit).
 *
 * The buffer limit (50 MB) is intentionally generous: compose can spew
 * a lot of output during `up` on cold image pulls, and silently truncating
 * would be surprising. Truly enormous output (multi-hundred-MB log dumps)
 * is the caller's problem and will manifest as an `ENOBUFS`-style error
 * surfacing via the rejected promise.
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
        // The default encoding for `execFile` (no `encoding` option) returns
        // strings to the callback. The runtime defensive coercion below
        // tolerates either string or Buffer in case the binding is invoked
        // with a different encoding by future callers; the cast to `unknown`
        // is what lets the runtime check do the work the type system can't.
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
          // execFile gives us `code` on the error for non-zero exits.
          // Distinguish "process spawned and exited non-zero" (resolve
          // with that code) from "process failed to spawn / was signaled"
          // (reject — caller can't proceed).
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

/**
 * Indirection seam for tests. Production code reads `_exec.current`;
 * tests overwrite it before driving the runner, restore it after.
 */
export const _exec: { current: ExecFn } = { current: realExec };

/**
 * Build the common prefix argv: `<cli-leading-args> -p <project> -f <file>...`.
 *
 * Files are passed as `-f <file>` pairs (rather than `-f file1 file2`)
 * because compose only treats the immediately-following token as the
 * file path; chained `-f` calls is the documented multi-file form.
 */
function baseArgs(ctx: RunnerCtx): string[] {
  const args: string[] = [...ctx.cli.args, "-p", ctx.project];
  for (const f of ctx.files) {
    args.push("-f", f);
  }
  return args;
}

/**
 * Run a subcommand with the assembled argv. Pure plumbing wrapper
 * around `_exec.current` so each public method stays a one-liner.
 */
function runSub(ctx: RunnerCtx, subArgs: string[]): Promise<RunResult> {
  return _exec.current(ctx.cli.cmd, [...baseArgs(ctx), ...subArgs], {
    cwd: ctx.cwd,
    env: ctx.env,
  });
}

/**
 * `<cli> compose -p <project> -f <file>... up [--detach] [services...]`.
 *
 * Defaults to detach mode (see file-level doc). Service filtering lets
 * callers do partial-up (e.g. `lich up postgres` to bring just one
 * service of a stack — handy for debugging).
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
 * `<cli> compose -p <project> -f <file>... down [-v] [--remove-orphans]`.
 *
 * `volumes` drops named volumes — destructive; lich's default `down`
 * leaves it off so user data (e.g. postgres data dir) survives a
 * teardown. `remove_orphans` cleans containers from older compose
 * configurations of the same project that aren't in the current files,
 * which prevents zombie services from a previous run sticking around.
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

/**
 * `<cli> compose -p <project> -f <file>... ps`.
 *
 * Returns the raw `{ exitCode, stdout, stderr }`. Higher-level code
 * (e.g. the future `lich stacks` integration) decides whether to ask
 * for JSON formatting and how to parse the result — kept out of this
 * layer so the runner stays a thin argv wrapper.
 */
export function ps(ctx: RunnerCtx): Promise<RunResult> {
  return runSub(ctx, ["ps"]);
}

/**
 * `<cli> compose -p <project> -f <file>... logs [--follow] [--tail N] [services...]`.
 *
 * `follow` keeps the process running and streams new lines (caller must
 * be ready to handle a long-lived promise / cancel via process kill).
 * `tail` limits the initial buffer to the last N lines per service.
 * Services come last so flags can't be eaten as service names.
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
