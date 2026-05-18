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

export interface DbSeedOptions {
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
 * Build `levelzero db seed`. Resolves the current worktree's stack, asks the
 * EnvSource registry for `DATABASE_URL` (via whichever DB plugin published
 * `<ns>.url` with `protocol: 'postgres'`), and invokes the ORM adapter's
 * seed implementation (which for prisma shells out to `prisma db seed`,
 * honoring `prisma.seed` in package.json).
 *
 * The adapter returns `{ ok, output }` rather than throwing — when `ok` is
 * false we wrap it in a CLIError so the top-level CLI driver propagates a
 * non-zero exit code.
 */
export function makeDbSeedCommand(opts?: DbSeedOptions): Command {
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

      const databaseUrl = await resolveDatabaseUrl({
        envSourceRegistry: getEnvSourceRegistry?.(),
        ports: entry.ports,
        projectRoot: stackCtx.worktreePath,
        worktreeKey: stackCtx.worktreeKey,
      });

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

      if (ctx.format === 'json') return { ok: true as const, output: result.output };
      const out = result.output ? `\n${result.output}` : '';
      return `db seed: ok${out}\n`;
    },
  };
}

export const dbSeedCommand: Command = makeDbSeedCommand();
