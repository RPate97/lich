import { spawn as defaultSpawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { CLIError } from '../errors';
import { Registry } from '../registry';
import { findWorktree } from '../worktree';
import type { Command } from './types';

/**
 * Result shape returned by the compose passthrough. We surface the exit code
 * so callers (and the CLI runner) can decide how to react; we never throw on
 * non-zero exits — `docker compose ps` exiting non-zero because the stack
 * isn't up is information, not an error.
 */
export interface ComposeResult {
  exitCode: number;
}

export interface MakeComposeCommandOptions {
  /**
   * Provider for the runtime {@link Registry} this command should consult to
   * find the compose file path for the active stack. Required: post-LEV-208
   * the passthrough no longer reconstructs the path from the worktree key
   * (the old hardcoded `.lich/docker-compose.yml` was wrong once `dev`
   * started writing per-worktree subdirs), it reads `entry.composeFile`
   * verbatim from the registry entry `dev` wrote.
   */
  getRegistry: () => Registry;
  /** Override `spawn` for tests; defaults to `node:child_process.spawn`. */
  spawn?: typeof defaultSpawn;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `lich compose <subcommand> [args...]` — thin wrapper around
 * `docker compose -p lich-<key> -f <composeFile> <subcommand>` that lets
 * operators reach for familiar compose tooling without having to remember the
 * per-worktree project name or compose file path.
 *
 * LEV-208 — the compose file path is read from the runtime registry entry
 * (`entry.composeFile`) that `dev` writes. The registry stores the absolute
 * path verbatim, so passthrough subcommands always shell into the same file
 * `dev`/`stop` use — no path reconstruction, no drift when the on-disk layout
 * changes again.
 *
 * All trailing positional args are forwarded transparently. Long-form flags
 * (`--foo bar`) are NOT forwarded — the CLI's top-level parser intercepts
 * them — so users should prefer the short-flag forms (`-f`, `-t`, …) that
 * `docker compose` already supports. This matches `lich curl`'s
 * passthrough approach for the same reason.
 *
 * Errors:
 *   - NO_PROJECT outside a worktree
 *   - NO_PROJECT when no registry entry exists for this worktree
 *     (the stack isn't running — run `dev` first)
 *   - NO_PROJECT when the registry entry exists but its `composeFile` points
 *     at a missing file (the file was deleted out from under us; `dev` again
 *     re-creates it)
 *   - CONFIG_INVALID when no subcommand is given
 *   - INTERNAL when `docker` itself can't be spawned (e.g. not on PATH)
 *
 * Exit code is forwarded transparently so scripts can react.
 */
export function makeComposeCommand(opts: MakeComposeCommandOptions): Command {
  const spawn = opts.spawn ?? defaultSpawn;
  const getRegistry = opts.getRegistry;

  return {
    name: 'compose',
    describe: 'Forward a subcommand to docker compose with the worktree project/file flags',
    async run(ctx) {
      if (ctx.args.length === 0) {
        throw new CLIError(
          'CONFIG_INVALID',
          'compose requires a subcommand',
          'usage: lich compose <subcommand> [args...]   (e.g., `lich compose ps`)',
        );
      }

      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        throw new CLIError(
          'NO_PROJECT',
          'not inside a lich project',
          'run `lich init` or cd into a directory with lich.config.ts',
        );
      }

      // LEV-208 — pull the compose file path from the registry entry rather
      // than reconstructing it. If the entry is missing the stack isn't
      // running; if `composeFile` is empty the entry is a legacy one written
      // before the field existed (also effectively "stack not running" from
      // the passthrough's perspective — re-run `dev` to refresh).
      const entry = await getRegistry().get(wt.key);
      if (!entry || !entry.composeFile) {
        throw new CLIError(
          'NO_PROJECT',
          `no running stack for ${wt.key}`,
          'run `lich up` to bring the stack up — that generates the compose file this command shells into',
        );
      }

      const composeFile = entry.composeFile;
      if (!(await fileExists(composeFile))) {
        throw new CLIError(
          'NO_PROJECT',
          `no compose file at ${composeFile}`,
          'run `lich up` to regenerate the compose file — it was removed since the stack came up',
        );
      }

      const projectName = `lich-${wt.key}`;
      // Order matters here: `-p` and `-f` must come BEFORE the subcommand,
      // mirroring `docker compose -p <name> -f <file> <subcommand>`. Putting
      // them after the subcommand breaks for several compose subcommands.
      const args = ['compose', '-p', projectName, '-f', composeFile, ...ctx.args];

      // `stdio: 'inherit'` wires the child's stdio directly to ours so
      // interactive subcommands (`logs -f`, `exec -it`, etc.) behave naturally
      // and operators see compose's output in real time. The trade-off: we
      // can't capture stdout for programmatic callers — those should use the
      // ComposeRunner in src/compose/runner.ts instead.
      return new Promise<unknown>((resolve, reject) => {
        const proc = spawn('docker', args, { stdio: 'inherit' });
        proc.on('error', (err: NodeJS.ErrnoException) => {
          // Most common case: docker isn't installed / not on PATH.
          // Surface as a CLIError so the runner formats it nicely instead of
          // letting the raw spawn error bubble up.
          reject(
            new CLIError('INTERNAL', `failed to spawn docker: ${err.message}`, {
              hint:
                err.code === 'ENOENT'
                  ? 'install Docker Desktop (or ensure `docker` is on PATH) and try again'
                  : undefined,
              cause: err,
              details: {
                command: `docker ${args.join(' ')}`,
                errno: err.code,
              },
            }),
          );
        });
        proc.on('close', (code) => {
          const result: ComposeResult = { exitCode: code ?? -1 };
          // Pretty mode: docker compose already wrote its output to inherited
          // stdio, so we don't print anything extra — return an empty string
          // so the bin caller doesn't append a stray blank line. JSON mode
          // gets the structured shape so scripts can branch on `exitCode`.
          if (ctx.format === 'json') resolve(result);
          else resolve('');
        });
      });
    },
  };
}
