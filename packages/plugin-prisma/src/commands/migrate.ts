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

export interface DbMigrateOptions {
  /** Registry provider; defaults to a Registry under $LICH_HOME/.lich/registry.json. */
  getRegistry?: () => Registry;
  /**
   * ORM adapter. When omitted (and no `getAdapterRegistry` is provided), the
   * command falls back to this package's `prismaAdapter`. Tests pass an
   * explicit stub to keep behaviour independent of the registry. Callers that
   * want `lich adapter swap orm ...` to take effect at runtime should
   * supply `getAdapterRegistry` instead — see field below.
   */
  adapter?: ORMAdapter;
  /**
   * AdapterRegistry provider used when `adapter` is omitted. No default — when
   * omitted the command uses `prismaAdapter` directly. This option exists so
   * the CLI bootstrapper can wire a merged registry (post-`bootPlugins`) for
   * adapter-swap dispatch without hard-coding the impl.
   */
  getAdapterRegistry?: () => AdapterRegistry;
  /**
   * Boot-scoped {@link EnvSourceRegistry}. Required for the command to derive
   * `DATABASE_URL` from whichever DB plugin published `<ns>.url` with
   * `protocol: 'postgres'`. Plumbed by the plugin's `register()` from
   * `PluginContext.getEnvSourceRegistry`. Tests inject a stub registry pre-
   * populated with a `postgres.url` named source.
   *
   * Composability (Plan 15 / LEV-171): this command must NOT import or
   * otherwise reach into a sibling DB plugin to compute the URL — the
   * EnvSource lookup is the only sanctioned cross-plugin channel.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
}

function defaultRegistry(): Registry {
  const home = process.env['LICH_HOME'] ?? homedir();
  return new Registry(join(home, '.lich', 'registry.json'));
}

/**
 * Build `lich db migrate`. Resolves the current worktree's stack, asks
 * the EnvSource registry for the active `postgres`-protocol URL source, and
 * invokes the ORM adapter's `applyMigrations` (which for prisma shells out
 * to `prisma migrate deploy`).
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
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  // Resolve the adapter lazily so tests that pass an explicit `adapter` or
  // `getAdapterRegistry` never construct a default registry, and so production
  // dispatch picks up an `adapter swap` that happens after command
  // construction. Default chain (post-LEV-149):
  //   1. opts.adapter (test-injected stub),
  //   2. opts.getAdapterRegistry().getActive('orm') (registry override),
  //   3. prismaAdapter (this package's impl — prisma is no longer in
  //      `getBuiltinAdapters()` after the extraction, so the registry path is
  //      only used when a caller wires it up explicitly).
  const resolveAdapter = (): ORMAdapter => {
    if (opts?.adapter) return opts.adapter;
    if (opts?.getAdapterRegistry) {
      return opts.getAdapterRegistry().getActive('orm') as ORMAdapter;
    }
    return prismaAdapter;
  };

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
          'run `lich dev` first to bring postgres up',
        );
      }

      // Resolve DATABASE_URL through the EnvSource registry. db.* commands run
      // on the host (not in a container), so we explicitly pass
      // `consumerContext: 'host'`. The lookup is by protocol so the command
      // works against any DB plugin that registers a `<ns>.url` source with
      // `protocol: 'postgres'` — plugin-prisma never imports plugin-postgres.
      const databaseUrl = await resolveDatabaseUrl({
        envSourceRegistry: getEnvSourceRegistry?.(),
        ports: entry.ports,
        projectRoot: stackCtx.worktreePath,
        worktreeKey: stackCtx.worktreeKey,
      });

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
        const json = {
          ok: true as const,
          applied: result.applied,
          names: result.names,
          output: result.output,
        };
        if (ctx.format === 'json') return json;
        const lines: string[] = [];
        lines.push(`db migrate: applied ${result.applied} migration(s)`);
        for (const n of result.names) lines.push(`  ${n}`);
        return lines.join('\n') + '\n';
      } catch (err) {
        // LEV-197 — forward the underlying error verbatim as `cause` so the
        // renderer walks the chain to the actual stderr blob. If the adapter
        // already threw a CLIError (with structured `stderr`/`exitCode`/etc.
        // in `details`), surface those fields too; otherwise fall back to a
        // single `output:` blob for non-CLIError throws.
        const adapterDetails =
          err instanceof CLIError && err.details && typeof err.details === 'object'
            ? (err.details as Record<string, unknown>)
            : undefined;
        const message = err instanceof Error ? err.message : String(err);
        throw new CLIError('INTERNAL', 'db migrate failed', {
          hint: 'see details for the adapter’s stdout/stderr',
          cause: err,
          details: adapterDetails ?? { output: message },
        });
      }
    },
  };
}

export const dbMigrateCommand: Command = makeDbMigrateCommand();
