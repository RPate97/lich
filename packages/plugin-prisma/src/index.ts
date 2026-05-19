import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { prismaAdapter } from './adapter';
import { makeDbMigrateCommand } from './commands/migrate';
import { makeDbMigrationNewCommand } from './commands/migration-new';
import { makeDbSeedCommand } from './commands/seed';
import { makeDbInspectCommand } from './commands/inspect';
import { prismaGenerator } from './generator';

export { prismaAdapter } from './adapter';
export { prismaGenerator, makePrismaGenerator } from './generator';
export {
  makeDbMigrateCommand,
  dbMigrateCommand,
  type DbMigrateOptions,
} from './commands/migrate';
export {
  makeDbMigrationNewCommand,
  dbMigrationNewCommand,
  type DbMigrationNewOptions,
} from './commands/migration-new';
export {
  makeDbSeedCommand,
  dbSeedCommand,
  type DbSeedOptions,
} from './commands/seed';
export {
  makeDbInspectCommand,
  dbInspectCommand,
  type DbInspectOptions,
} from './commands/inspect';

/**
 * Options for the `@levelzero/plugin-prisma` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface PrismaOptions {
  /** Override the default `'prisma'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-prisma` — extracts the Prisma `ORMAdapter` impl plus the
 * `db.*` command family out of `@levelzero/core` (LEV-149).
 *
 * Contributes:
 *   - the `prisma` impl under the `orm` adapter slot (marked active by
 *     default so projects that previously relied on the implicit built-in
 *     keep the same behavior after the extraction); and
 *   - four commands: `db.migrate`, `db.migration.new`, `db.seed`,
 *     `db.inspect`. Each is wired to `prismaAdapter` directly so the commands
 *     work even when the host CLI doesn't bother to re-bind them against the
 *     merged adapter registry. Consumers who need adapter-swap support for
 *     orm at runtime can override these via `addCommand` from a later plugin
 *     — `CommandRegistry.register` is last-write-wins.
 *
 * Cross-plugin composition (LEV-171): the db.* commands derive
 * `DATABASE_URL` from whichever DB plugin published a `<ns>.url` named
 * EnvSource with `protocol: 'postgres'`. The plugin captures
 * `PluginContext.getEnvSourceRegistry` here and threads it into every
 * command factory so the closure resolves the FULLY populated registry at
 * command-run time. plugin-prisma never imports any sibling DB plugin
 * directly — composability lives in the EnvSource contract, not in
 * package-level dependencies.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import prisma from '@levelzero/plugin-prisma';
 *
 * export default {
 *   plugins: [prisma()],
 * };
 * ```
 */
export default function prisma(opts: PrismaOptions = {}): Plugin<
  'prisma',
  {
    // plugin-prisma is a pure ORM consumer — it doesn't publish env sources.
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-prisma',
    namespace: (opts.namespace ?? 'prisma') as 'prisma',
    version: '0.1.0',

    register(api: PluginAPI<'prisma'>, ctx: PluginContext): void {
      api.addAdapter('orm', 'prisma', prismaAdapter);
      api.setActiveAdapter('orm', 'prisma');

      // LEV-124: contribute the `prisma` generator so `levelzero gen` can
      // drive `prisma generate` alongside other plugin-contributed
      // generators from a single invocation. Skips cleanly when the project
      // has no `prisma/schema.prisma` (see `./generator.ts`).
      api.addGenerator(prismaGenerator);

      // Capture the EnvSource registry getter once; the closure resolves to
      // the same mutable registry object at command-run time. The
      // `?.()` chain stays optional-safe so synthetic PluginContexts
      // produced by tests (without `getEnvSourceRegistry`) don't crash
      // at command-construction. Commands surface a clear "registry not
      // available" CLIError if they're invoked without one wired in.
      const getEnvSourceRegistry = ctx.getEnvSourceRegistry;

      api.addCommand(
        makeDbMigrateCommand({ adapter: prismaAdapter, getEnvSourceRegistry }),
      );
      api.addCommand(
        makeDbMigrationNewCommand({ adapter: prismaAdapter, getEnvSourceRegistry }),
      );
      api.addCommand(
        makeDbSeedCommand({ adapter: prismaAdapter, getEnvSourceRegistry }),
      );
      api.addCommand(
        makeDbInspectCommand({ adapter: prismaAdapter, getEnvSourceRegistry }),
      );
    },
  };
}
