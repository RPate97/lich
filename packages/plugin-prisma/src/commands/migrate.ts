import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '@levelzero/core/errors';
import { Registry } from '@levelzero/core/registry';
import { resolveStackContext } from '@levelzero/core/services/context';
import type { AdapterRegistry } from '@levelzero/core/adapters/registry';
import type { Command, ORMAdapter } from '@levelzero/core';
import { prismaAdapter } from '../adapter';

export interface DbMigrateOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
  getRegistry?: () => Registry;
  /**
   * ORM adapter. When omitted (and no `getAdapterRegistry` is provided), the
   * command falls back to this package's `prismaAdapter`. Tests pass an
   * explicit stub to keep behaviour independent of the registry. Callers that
   * want `levelzero adapter swap orm ...` to take effect at runtime should
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
          'run `levelzero dev` first to bring postgres up',
        );
      }

      // DATABASE_URL formula mirrors the postgres plugin's
      // `addEnvSource('url', …)` registration (LEV-187) — the single source of
      // truth for connection-string shape lives in plugin-postgres' index.
      // Inlined here because the prisma commands run before EnvSource
      // resolution is plumbed into the command-context (Plan 16 Tier 2 lands
      // that separately).
      const postgresPort = entry.ports['postgres'];
      if (!postgresPort) {
        throw new CLIError(
          'NO_PROJECT',
          'current stack has no postgres service',
          'ensure postgres is part of the stack and `levelzero dev` has been run',
        );
      }
      const databaseUrl = `postgres://levelzero:levelzero@localhost:${postgresPort}/levelzero`;

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
