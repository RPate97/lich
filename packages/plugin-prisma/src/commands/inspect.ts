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

export interface DbInspectOptions {
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

/** Default row limit per the LEV-58 spec. */
const DEFAULT_ROW_LIMIT = 50;

function defaultRegistry(): Registry {
  const home = process.env['LICH_HOME'] ?? homedir();
  return new Registry(join(home, '.lich', 'registry.json'));
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
 * Build `lich db inspect`. Two modes:
 *
 *   --schema           → JSON dump of tables + columns (via prismaAdapter.inspectSchema)
 *   --rows <table>     → JSON rows from a single table (via prismaAdapter.inspectTable)
 *   [--limit N]        → row cap for --rows mode (default 50)
 *
 * Output is always JSON in v0; the `--json` flag is accepted as a no-op alias.
 *
 * We resolve the worktree, then ask the EnvSource registry for the active
 * `postgres`-protocol `*.url` source (every db.* command uses the same
 * lookup — see {@link resolveDatabaseUrl}). This keeps plugin-prisma free
 * of any direct dependency on a sibling DB plugin; the composability
 * principle (Plan 15 / LEV-171) requires plugins to talk through registry
 * lookups rather than each other's package internals.
 */
export function makeDbInspectCommand(opts?: DbInspectOptions): Command {
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
          'usage: lich db inspect --schema | --rows <table> [--limit N]',
        );
      }

      let table: string | undefined;
      let limit: number | undefined;
      if (rowsMode) {
        if (typeof rowsFlag !== 'string' || rowsFlag.length === 0) {
          throw new CLIError(
            'CONFIG_INVALID',
            '--rows requires a table name',
            'usage: lich db inspect --rows <table> [--limit N]',
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
          'run `lich up` first to bring postgres up',
        );
      }

      const databaseUrl = await resolveDatabaseUrl({
        envSourceRegistry: getEnvSourceRegistry?.(),
        ports: entry.ports,
        projectRoot: stackCtx.worktreePath,
        worktreeKey: stackCtx.worktreeKey,
      });

      const ormCtx = { databaseUrl, projectRoot: stackCtx.worktreePath };
      const adapter = resolveAdapter();

      if (schemaMode) {
        // --schema takes precedence if (somehow) both flags are set; this
        // matches the docs which describe the two modes as alternatives.
        const schema = await adapter.inspectSchema(ormCtx);
        if (ctx.format === 'json') return schema;
        return renderSchemaPretty(schema);
      }

      // rowsMode is true here (we validated above); table is set.
      const rows = await adapter.inspectTable(ormCtx, table as string, limit);
      if (ctx.format === 'json') return rows;
      return renderRowsPretty(table as string, rows);
    },
  };
}

interface InspectSchema {
  tables: Record<string, { columns: Array<{ name: string; type: string; nullable: boolean }> }>;
}

function renderSchemaPretty(schema: InspectSchema): string {
  const tables = Object.keys(schema.tables).sort();
  if (tables.length === 0) return 'no tables\n';
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`# ${t}`);
    const cols = schema.tables[t]?.columns ?? [];
    for (const c of cols) {
      const nullable = c.nullable ? '?' : '';
      lines.push(`  ${c.name}: ${c.type}${nullable}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderRowsPretty(table: string, rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return `# ${table}\n(no rows)\n`;
  const lines: string[] = [`# ${table} (${rows.length} row(s))`];
  for (const r of rows) {
    const entries = Object.entries(r)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('  ');
    lines.push(entries);
  }
  return lines.join('\n') + '\n';
}

export const dbInspectCommand: Command = makeDbInspectCommand();
