import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../errors';
import { Registry } from '../../registry';
import { pgService } from '../../services/postgres';
import { resolveStackContext } from '../../services/context';
import { prismaAdapter } from '../../adapters/orm/prisma';
import type { ORMAdapter } from '../../adapters/orm/types';
import type { Command } from '../types';

export interface DbInspectOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /** ORM adapter; defaults to prismaAdapter. Tests inject a stub. */
  adapter?: ORMAdapter;
}

/** Default row limit per the LEV-58 spec. */
const DEFAULT_ROW_LIMIT = 50;

function defaultRegistry(): Registry {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

function parseLimitFlag(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') {
    throw new CLIError('CONFIG_INVALID', '--limit requires a value');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CLIError(
      'CONFIG_INVALID',
      `--limit must be a positive integer, got: ${value}`,
    );
  }
  return n;
}

/**
 * Build `levelzero db inspect`. Two modes:
 *
 *   --schema           → JSON dump of tables + columns (via prismaAdapter.inspectSchema)
 *   --rows <table>     → JSON rows from a single table (via prismaAdapter.inspectTable)
 *   [--limit N]        → row cap for --rows mode (default 50)
 *
 * Output is always JSON in v0; the `--json` flag is accepted as a no-op alias.
 *
 * We resolve the worktree, look up its postgres port in the registry, and
 * derive DATABASE_URL through pgService.envContributions — the same path used
 * by every other db.* command so the URL stays consistent with what the
 * running container actually serves.
 */
export function makeDbInspectCommand(opts?: DbInspectOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const adapter = opts?.adapter ?? prismaAdapter;

  return {
    name: 'db.inspect',
    describe:
      'Inspect the current stack’s database — dump schema (--schema) or rows from a table (--rows <table>)',
    async run(ctx) {
      const schemaMode = Boolean(ctx.flags['schema']);
      const rowsFlag = ctx.flags['rows'];
      const rowsMode = rowsFlag !== undefined && rowsFlag !== false;

      // Validate flags up front — before we do the (slower) stack lookup — so
      // misuse fails fast with a clear hint. Spec requires exactly one of the
      // two modes; we accept --schema *or* --rows but not neither.
      if (!schemaMode && !rowsMode) {
        throw new CLIError(
          'CONFIG_INVALID',
          'db inspect requires either --schema or --rows <table>',
          'usage: levelzero db inspect --schema | --rows <table> [--limit N]',
        );
      }

      let table: string | undefined;
      let limit: number | undefined;
      if (rowsMode) {
        if (typeof rowsFlag !== 'string' || rowsFlag.length === 0) {
          throw new CLIError(
            'CONFIG_INVALID',
            '--rows requires a table name',
            'usage: levelzero db inspect --rows <table> [--limit N]',
          );
        }
        table = rowsFlag;
        limit = parseLimitFlag(ctx.flags['limit']) ?? DEFAULT_ROW_LIMIT;
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

      const ormCtx = { databaseUrl, projectRoot: stackCtx.worktreePath };

      if (schemaMode) {
        // --schema takes precedence if (somehow) both flags are set; this
        // matches the docs which describe the two modes as alternatives.
        return await adapter.inspectSchema(ormCtx);
      }

      // rowsMode is true here (we validated above); table is set.
      return await adapter.inspectTable(ormCtx, table as string, limit);
    },
  };
}

export const dbInspectCommand: Command = makeDbInspectCommand();
