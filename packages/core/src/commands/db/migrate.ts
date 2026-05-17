import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../errors';
import { Registry } from '../../registry';
import { pgService } from '@levelzero/plugin-postgres';
import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { ORMAdapter } from '../../adapters/orm/types';
import type { Command } from '../types';

export interface DbMigrateOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /**
   * ORM adapter. When omitted, the command resolves the active impl from the
   * AdapterRegistry returned by `getAdapterRegistry` (default:
   * `getBuiltinAdapters()`), so `levelzero adapter swap orm ...` takes effect
   * without changing this file. Tests pass an explicit stub to keep
   * behavior independent of the global registry state.
   */
  adapter?: ORMAdapter;
  /**
   * AdapterRegistry provider used when `adapter` is omitted. Defaults to
   * `getBuiltinAdapters` — a fresh registry per call so tests don't share
   * mutable state.
   */
  getAdapterRegistry?: () => AdapterRegistry;
}

function defaultRegistry(): Registry {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

/**
 * Build `levelzero db migrate`. Resolves the current worktree's stack, derives
 * DATABASE_URL from the running postgres service, and invokes the ORM
 * adapter's `applyMigrations` (which for prisma shells out to
 * `prisma migrate deploy`).
 *
 * Flags:
 *   --dev            accepted for forward-compat; the prisma adapter currently
 *                    runs `migrate deploy` for both modes. A future adapter
 *                    revision will route `--dev` to `migrate dev`.
 *   --schema <path>  accepted for forward-compat; the adapter currently
 *                    derives the schema path from `projectRoot`.
 *
 * The adapter throws on non-zero exits, so we wrap any thrown error in a
 * CLIError to keep stdout/stderr machine-parseable and ensure the CLI driver
 * surfaces a non-zero exit.
 */
export function makeDbMigrateCommand(opts?: DbMigrateOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  // Resolve the adapter lazily so that tests that pass an explicit `adapter`
  // never touch the AdapterRegistry, and so production builds pick up adapter
  // swaps that happen between command construction and first run.
  const resolveAdapter = (): ORMAdapter =>
    opts?.adapter ?? (getAdapterRegistry().getActive('orm') as ORMAdapter);

  return {
    name: 'db.migrate',
    describe: 'Apply pending migrations to the current stack’s database via the ORM adapter',
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

      // Keep DATABASE_URL derivation in lockstep with `dev` and `db seed` — pgService
      // owns the single source of truth.
      const env = pgService.envContributions(entry.ports);
      const databaseUrl = env['DATABASE_URL'];
      if (!databaseUrl || !entry.ports['postgres']) {
        throw new CLIError(
          'NO_PROJECT',
          'current stack has no postgres service',
          'ensure postgres is part of the stack and `levelzero dev` has been run',
        );
      }

      // Flags are accepted but the prisma adapter currently runs `migrate deploy`
      // for either mode. We touch the flags so they're not flagged as unused, and
      // so future adapters can branch on the captured mode/schema.
      void ctx.flags['dev'];
      void ctx.flags['schema'];

      try {
        const result = await resolveAdapter().applyMigrations({
          databaseUrl,
          projectRoot: stackCtx.worktreePath,
        });
        return {
          ok: true,
          applied: result.applied,
          names: result.names,
          output: result.output,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CLIError('INTERNAL', 'db migrate failed', {
          hint: 'see details.output for the adapter’s stdout/stderr',
          details: { output: message },
        });
      }
    },
  };
}

export const dbMigrateCommand: Command = makeDbMigrateCommand();
