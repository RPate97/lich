import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Result returned by every `runLichAction` call. */
export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Shell into `lich <command>` for a given stack's worktree.
 *
 * Runs `bun run lich <command>` with `cwd` set to `worktreePath` so
 * the CLI picks up the correct stack context. A generous 30-second timeout
 * accommodates `restart` (which is essentially a `dev` cold-start).
 *
 * Never throws — any spawn or process error is captured and returned as
 * `{ ok: false, exitCode: -1, stderr: err.message }`.
 *
 * Named `runLichAction` after the LEV-221 rename from `levelzero` to
 * `lich`. The binary it shells out to is the `bin.lich` entry in
 * `packages/core/package.json`.
 */
export async function runLichAction(
  worktreePath: string,
  command: 'restart' | 'stop',
): Promise<ActionResult> {
  try {
    const { stdout, stderr } = await execFile('bun', ['run', 'lich', command], {
      cwd: worktreePath,
      timeout: 30_000,
    });
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    // execFile rejects with an error that may carry `.code` (exit code) and
    // `.stdout` / `.stderr` (partial output captured before failure).
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    // Prefer the numeric exit code when available.
    const exitCode = typeof e.code === 'number' ? e.code : -1;
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? e.message ?? String(err);

    return { ok: false, exitCode, stdout, stderr };
  }
}
