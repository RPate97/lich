import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '@levelzero/core/errors';
import { Registry } from '@levelzero/core/registry';
import { resolveStackContext } from '@levelzero/core/services/context';
import type { AdapterRegistry } from '@levelzero/core/adapters/registry';
import type { EnvSourceRegistry } from '@levelzero/core/env/registry';
import type { Command, ORMAdapter } from '@levelzero/core';
import { prismaAdapter } from '../adapter';
import { resolveDatabaseUrl } from './database-url';

export interface DbResetOptions {
  /** Registry provider; defaults to a Registry under $LEVELZERO_HOME/.levelzero/registry.json. */
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
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return new Registry(join(home, '.levelzero', 'registry.json'));
}

/**
 * Build `levelzero db reset`. Three-step pipeline executed in order against
 * the active ORM adapter:
 *
 *   1. `orm.resetDatabase(ctx)`  — driver-agnostic teardown of user tables.
 *      The ORM owns ALL driver-specific code (LEV-172 moved the raw `pg`
 *      `DROP SCHEMA` out of this command and into `prismaAdapter`); this
 *      command itself contains no SQL.
 *   2. `orm.applyMigrations(ctx)` — re-create the schema from migrations.
 *   3. `orm.seed(ctx)`           — optional; skipped when `--skip-seed`.
 *
 * The result shape mirrors the per-step booleans so consumers piping `--json`
 * can switch on which steps actually ran:
 *
 *   { reset: true, migrated: true, seeded: boolean }
 *
 * Distinction from the top-level `levelzero reset` command: that one nukes
 * the entire stack (containers + volumes); `db reset` is data-only against
 * the *running* database. Much faster iteration when you just need a clean
 * schema + seed without restarting the container.
 */
export function makeDbResetCommand(opts?: DbResetOptions): Command {
  const getRegistry = opts?.getRegistry ?? defaultRegistry;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  // Same lazy-resolution chain as the sibling db.* commands — see the
  // longer comment in `migrate.ts` for the rationale. In short: tests inject
  // `adapter`, production wires `getAdapterRegistry` so `adapter swap` takes
  // effect, and the `prismaAdapter` default keeps this command working when
  // the host CLI didn't rebind it against the merged registry.
  const resolveAdapter = (): ORMAdapter => {
    if (opts?.adapter) return opts.adapter;
    if (opts?.getAdapterRegistry) {
      return opts.getAdapterRegistry().getActive('orm') as ORMAdapter;
    }
    return prismaAdapter;
  };

  return {
    name: 'db.reset',
    describe:
      'Reset the current stack’s database — drop user tables, re-apply migrations, and re-seed (use --skip-seed to skip the seed step)',
    async run(ctx) {
      const skipSeed = Boolean(ctx.flags['skip-seed']);

      const stackCtx = await resolveStackContext(ctx.cwd);
      const entry = await getRegistry().get(stackCtx.worktreeKey);
      if (!entry) {
        throw new CLIError(
          'NO_PROJECT',
          'no stack running for this worktree',
          'run `levelzero dev` first to bring postgres up',
        );
      }

      const databaseUrl = await resolveDatabaseUrl({
        envSourceRegistry: getEnvSourceRegistry?.(),
        ports: entry.ports,
        projectRoot: stackCtx.worktreePath,
        worktreeKey: stackCtx.worktreeKey,
      });

      const adapter = resolveAdapter();
      const ormCtx = { databaseUrl, projectRoot: stackCtx.worktreePath };

      // Step 1: tear down. The adapter owns the dispatch on driver shape;
      // we just await and wrap any thrown error in a structured CLIError so
      // the CLI driver exits non-zero with a consistent payload across the
      // three steps (the alternative — letting raw errors bubble — would
      // produce a `code: 'INTERNAL'` with a noisy un-formatted message).
      try {
        await adapter.resetDatabase(ormCtx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CLIError('INTERNAL', 'db reset: drop step failed', {
          hint: 'see details.output for the adapter’s error',
          details: { output: message },
        });
      }

      // Step 2: re-create schema from migrations. Same wrap-and-rethrow as
      // step 1 — we deliberately surface a different message ("migrate step
      // failed") so a partially-completed reset is debuggable from the
      // CLIError alone without having to scroll back through earlier output.
      try {
        await adapter.applyMigrations(ormCtx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CLIError('INTERNAL', 'db reset: migrate step failed', {
          hint: 'see details.output for the adapter’s error',
          details: { output: message },
        });
      }

      // Step 3: seed (optional). Unlike step 1/2 the adapter returns
      // `{ ok, output }` rather than throwing, so we branch on `ok` instead
      // of try/catch. `--skip-seed` short-circuits before we even touch the
      // adapter — important so projects without a `prisma.seed` configured
      // don't fail the whole reset when they pass the flag.
      let seeded = false;
      if (!skipSeed) {
        try {
          const seedResult = await adapter.seed(ormCtx);
          if (!seedResult.ok) {
            throw new CLIError('INTERNAL', 'db reset: seed step failed', {
              hint: 'see details.output for the seed script’s stdout/stderr',
              details: { output: seedResult.output },
            });
          }
          seeded = true;
        } catch (err) {
          if (err instanceof CLIError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CLIError('INTERNAL', 'db reset: seed step failed', {
            hint: 'see details.output for the adapter’s error',
            details: { output: message },
          });
        }
      }

      const json = { reset: true as const, migrated: true as const, seeded };
      if (ctx.format === 'json') return json;

      // Pretty output — matches the LEV-168 `[OK] <command>` header pattern
      // used by `gen` and friends, then a two-column status table so a quick
      // scan tells the user which steps ran.
      const lines: string[] = [];
      lines.push('[OK] db reset');
      lines.push('  reset    yes');
      lines.push('  migrated yes');
      lines.push(`  seeded   ${seeded ? 'yes' : 'no'}`);
      return lines.join('\n') + '\n';
    },
  };
}

export const dbResetCommand: Command = makeDbResetCommand();
