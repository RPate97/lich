import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../errors';
import { Registry } from '../../registry';
import { pgService } from '../../services/postgres';
import { resolveStackContext } from '../../services/context';
import { prismaAdapter } from '../../adapters/orm/prisma';
import type { ORMAdapter } from '../../adapters/orm/types';
import type { Command } from '../types';

export interface DbMigrationNewOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /** ORM adapter; defaults to prismaAdapter. Tests inject a stub. */
  adapter?: ORMAdapter;
}

function defaultRegistry(): Registry {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

/**
 * Prisma's CLI requires migration names to be a single snake_case token —
 * leading letter, then [a-z0-9_]. We validate before shelling out so we can
 * fail fast with a structured CLIError rather than a wall of Prisma noise.
 *
 * NOTE: we deliberately reject leading digits even though Prisma itself would
 * accept them — they make migration dirs visually indistinguishable from the
 * timestamp prefix Prisma prepends.
 */
const MIGRATION_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Build `levelzero db migration new <name>`. Validates `<name>` as snake_case,
 * resolves the current worktree's stack to derive DATABASE_URL, then asks the
 * ORM adapter to scaffold a new migration. For prisma this shells out to
 * `prisma migrate dev --create-only`, producing
 * `prisma/migrations/<timestamp>_<name>/migration.sql`.
 *
 * On success the result includes the absolute path of the generated migration
 * directory so callers (humans and JSON consumers alike) can jump straight to
 * editing it.
 */
export function makeDbMigrationNewCommand(opts?: DbMigrationNewOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const adapter = opts?.adapter ?? prismaAdapter;

  return {
    name: 'db.migration.new',
    describe: 'Scaffold a new migration for the current stack via the ORM adapter',
    async run(ctx) {
      const rawName = ctx.args[0];
      if (!rawName || rawName.trim() === '') {
        throw new CLIError(
          'CONFIG_INVALID',
          'missing required <name> argument',
          'usage: levelzero db migration new <snake_case_name>',
        );
      }
      if (!MIGRATION_NAME_RE.test(rawName)) {
        throw new CLIError(
          'CONFIG_INVALID',
          `invalid migration name "${rawName}"`,
          'use snake_case: lowercase letters, digits, underscores; must start with a letter (e.g. "add_users")',
        );
      }

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
      // build DATABASE_URL — keep this in lockstep with `dev` / `db seed`.
      const env = pgService.envContributions(entry.ports);
      const databaseUrl = env['DATABASE_URL'];
      if (!databaseUrl || !entry.ports['postgres']) {
        throw new CLIError(
          'NO_PROJECT',
          'current stack has no postgres service',
          'ensure postgres is part of the stack and `levelzero dev` has been run',
        );
      }

      let result;
      try {
        result = await adapter.newMigration(
          {
            databaseUrl,
            projectRoot: stackCtx.worktreePath,
          },
          rawName,
        );
      } catch (e) {
        // Wrap adapter throws so the CLI driver returns a non-zero exit code
        // with a structured error rather than an unhandled rejection.
        const msg = e instanceof Error ? e.message : String(e);
        throw new CLIError('INTERNAL', 'db migration new failed', {
          hint: 'see details.output for the adapter’s stdout/stderr',
          details: { output: msg },
        });
      }

      return { ok: true, path: result.path, name: result.name };
    },
  };
}

export const dbMigrationNewCommand: Command = makeDbMigrationNewCommand();
