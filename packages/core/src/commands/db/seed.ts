import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../errors';
import { Registry } from '../../registry';
import { pgService } from '@levelzero/plugin-postgres';
import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { ORMAdapter } from '../../adapters/orm/types';
import type { Command } from '../types';

export interface DbSeedOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /**
   * ORM adapter. When omitted, resolved from the AdapterRegistry returned by
   * `getAdapterRegistry` (default `getBuiltinAdapters()`); tests pass an
   * explicit stub to bypass the registry entirely.
   */
  adapter?: ORMAdapter;
  /** AdapterRegistry provider used when `adapter` is omitted. */
  getAdapterRegistry?: () => AdapterRegistry;
}

function defaultRegistry(): Registry {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

/**
 * Build `levelzero db seed`. Resolves the current worktree's stack, derives
 * DATABASE_URL from the running postgres service, and invokes the ORM
 * adapter's seed implementation (which for prisma shells out to
 * `prisma db seed`, honoring `prisma.seed` in package.json).
 *
 * The adapter returns `{ ok, output }` rather than throwing — when `ok` is
 * false we wrap it in a CLIError so the top-level CLI driver propagates a
 * non-zero exit code.
 */
export function makeDbSeedCommand(opts?: DbSeedOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  const resolveAdapter = (): ORMAdapter =>
    opts?.adapter ?? (getAdapterRegistry().getActive('orm') as ORMAdapter);

  return {
    name: 'db.seed',
    describe: 'Seed the current stack’s database via the ORM adapter',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const entry = await getRegistry().get(stackCtx.worktreeKey);
      if (!entry) {
        throw new CLIError(
          'NO_PROJECT',
          'no stack running for this worktree',
          'run `levelzero dev` first to bring postgres up',
        );
      }

      // pgService.envContributions is the single source of truth for how we
      // build DATABASE_URL — keep this in lockstep with `dev`.
      const env = pgService.envContributions(entry.ports);
      const databaseUrl = env['DATABASE_URL'];
      if (!databaseUrl || !entry.ports['postgres']) {
        throw new CLIError(
          'NO_PROJECT',
          'current stack has no postgres service',
          'ensure postgres is part of the stack and `levelzero dev` has been run',
        );
      }

      const result = await resolveAdapter().seed({
        databaseUrl,
        projectRoot: stackCtx.worktreePath,
      });

      if (!result.ok) {
        // Surface adapter output in details so it ends up in the structured
        // error JSON; the CLI driver returns exit 1 on any CLIError throw.
        throw new CLIError('INTERNAL', 'db seed failed', {
          hint: 'see details.output for the seed script’s stdout/stderr',
          details: { output: result.output },
        });
      }

      return { ok: true, output: result.output };
    },
  };
}

export const dbSeedCommand: Command = makeDbSeedCommand();
