import { spawn as defaultSpawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIError } from '../errors';
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
  /** Override `spawn` for tests; defaults to `node:child_process.spawn`. */
  spawn?: typeof defaultSpawn;
}

const COMPOSE_FILE_SUBPATH = join('.levelzero', 'docker-compose.yml');

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `levelzero compose <subcommand> [args...]` — thin wrapper around
 * `docker compose -p levelzero-<key> -f <worktree>/.levelzero/docker-compose.yml`
 * that lets operators reach for familiar compose tooling without having to
 * remember the per-worktree project name or compose file path.
 *
 * All trailing positional args are forwarded transparently. Long-form flags
 * (`--foo bar`) are NOT forwarded — the CLI's top-level parser intercepts
 * them — so users should prefer the short-flag forms (`-f`, `-t`, …) that
 * `docker compose` already supports. This matches `levelzero curl`'s
 * passthrough approach for the same reason.
 *
 * Errors:
 *   - NO_PROJECT outside a worktree
 *   - NO_PROJECT when the generated compose file is missing (run `dev` first)
 *   - CONFIG_INVALID when no subcommand is given
 *   - INTERNAL when `docker` itself can't be spawned (e.g. not on PATH)
 *
 * Exit code is forwarded transparently so scripts can react.
 */
export function makeComposeCommand(opts: MakeComposeCommandOptions = {}): Command {
  const spawn = opts.spawn ?? defaultSpawn;

  return {
    name: 'compose',
    describe: 'Forward a subcommand to docker compose with the worktree project/file flags',
    async run(ctx) {
      if (ctx.args.length === 0) {
        throw new CLIError(
          'CONFIG_INVALID',
          'compose requires a subcommand',
          'usage: levelzero compose <subcommand> [args...]   (e.g., `levelzero compose ps`)',
        );
      }

      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        throw new CLIError(
          'NO_PROJECT',
          'not inside a levelzero project',
          'run `levelzero init` or cd into a directory with levelzero.config.ts',
        );
      }

      const composeFile = join(wt.path, COMPOSE_FILE_SUBPATH);
      if (!(await fileExists(composeFile))) {
        throw new CLIError(
          'NO_PROJECT',
          `no compose file at ${composeFile}`,
          'run `levelzero dev` to bring the stack up — that generates the compose file this command shells into',
        );
      }

      const projectName = `levelzero-${wt.key}`;
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
            new CLIError(
              'INTERNAL',
              `failed to spawn docker: ${err.message}`,
              err.code === 'ENOENT'
                ? 'install Docker Desktop (or ensure `docker` is on PATH) and try again'
                : undefined,
            ),
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

/**
 * Default `composeCommand` instance. Exported alongside the factory so
 * imports that don't need DI get a working `Command` for free.
 */
export const composeCommand: Command = makeComposeCommand();
