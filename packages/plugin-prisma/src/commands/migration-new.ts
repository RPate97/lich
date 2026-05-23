import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '@lich/core/errors';
import { Registry } from '@lich/core/registry';
import { resolveStackContext } from '@lich/core/services/context';
import type { AdapterRegistry } from '@lich/core/adapters/registry';
import type { EnvSourceRegistry } from '@lich/core/env/registry';
import type { Command, ORMAdapter } from '@lich/core';
import { prismaAdapter } from '../adapter';
import { resolveDatabaseUrl } from './database-url';

export interface DbMigrationNewOptions {
  /** Registry provider; defaults to a Registry under $LICH_HOME/.lich/registry.json. */
  getRegistry?: () => Registry;
  /**
   * ORM adapter. When omitted (and no `getAdapterRegistry` is provided), the
   * command falls back to this package's `prismaAdapter`. Tests pass an
   * explicit stub to bypass the registry entirely.
   */
  adapter?: ORMAdapter;
  /**
   * AdapterRegistry provider used when `adapter` is omitted. No default —
   * when omitted the command uses `prismaAdapter` directly.
   */
  getAdapterRegistry?: () => AdapterRegistry;
  /**
   * Boot-scoped {@link EnvSourceRegistry}. See `DbMigrateOptions` for the
   * full rationale — db.* commands consume `DATABASE_URL` only via the
   * registry to preserve the composability principle (Plan 15 / LEV-171).
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
}

function defaultRegistry(): Registry {
  const home = process.env['LICH_HOME'] ?? homedir();
  return new Registry(join(home, '.lich', 'registry.json'));
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
 * Build `lich db migration new <name>`. Validates `<name>` as snake_case,
 * resolves the current worktree's stack, asks the EnvSource registry for
 * `DATABASE_URL`, then asks the ORM adapter to scaffold a new migration. For
 * prisma this shells out to `prisma migrate dev --create-only`, producing
 * `prisma/migrations/<timestamp>_<name>/migration.sql`.
 *
 * On success the result includes the absolute path of the generated migration
 * directory so callers (humans and JSON consumers alike) can jump straight to
 * editing it.
 */
export function makeDbMigrationNewCommand(opts?: DbMigrationNewOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  const resolveAdapter = (): ORMAdapter => {
    if (opts?.adapter) return opts.adapter;
    if (opts?.getAdapterRegistry) {
      return opts.getAdapterRegistry().getActive('orm') as ORMAdapter;
    }
    return prismaAdapter;
  };

  return {
    name: 'db.migration.new',
    describe: 'Scaffold a new migration for the current stack via the ORM adapter',
    async run(ctx) {
      const rawName = ctx.args[0];
      if (!rawName || rawName.trim() === '') {
        throw new CLIError(
          'CONFIG_INVALID',
          'missing required <name> argument',
          'usage: lich db migration new <snake_case_name>',
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
          'run `lich up` first to bring postgres up',
        );
      }

      const databaseUrl = await resolveDatabaseUrl({
        envSourceRegistry: getEnvSourceRegistry?.(),
        ports: entry.ports,
        projectRoot: stackCtx.worktreePath,
        worktreeKey: stackCtx.worktreeKey,
      });

      let result;
      try {
        result = await resolveAdapter().newMigration(
          {
            databaseUrl,
            projectRoot: stackCtx.worktreePath,
          },
          rawName,
        );
      } catch (e) {
        // LEV-197 — forward the adapter's structured `stderr`/`exitCode`
        // details (when it threw a CLIError) so the renderer surfaces the
        // actual prisma error inline. Plain Error throws fall back to a
        // single `output:` blob for back-compat.
        const adapterDetails =
          e instanceof CLIError && e.details && typeof e.details === 'object'
            ? (e.details as Record<string, unknown>)
            : undefined;
        const msg = e instanceof Error ? e.message : String(e);
        throw new CLIError('INTERNAL', 'db migration new failed', {
          hint: 'see details for the adapter’s stdout/stderr',
          cause: e,
          details: adapterDetails ?? { output: msg },
        });
      }

      const json = { ok: true as const, path: result.path, name: result.name };
      if (ctx.format === 'json') return json;
      return `Created migration "${result.name}"\n  ${result.path}\n`;
    },
  };
}

export const dbMigrationNewCommand: Command = makeDbMigrationNewCommand();
