import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { prismaAdapter } from './adapter';
import { makeDbMigrateCommand } from './commands/migrate';
import { makeDbMigrationNewCommand } from './commands/migration-new';
import { makeDbSeedCommand } from './commands/seed';
import { makeDbInspectCommand } from './commands/inspect';

export { prismaAdapter } from './adapter';
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
    // Filled in by LEV-187 if prisma ends up publishing env sources.
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-prisma',
    namespace: (opts.namespace ?? 'prisma') as 'prisma',
    version: '0.1.0',

    register(api: PluginAPI<'prisma'>, _ctx: PluginContext): void {
      api.addAdapter('orm', 'prisma', prismaAdapter);
      api.setActiveAdapter('orm', 'prisma');

      api.addCommand(makeDbMigrateCommand({ adapter: prismaAdapter }));
      api.addCommand(makeDbMigrationNewCommand({ adapter: prismaAdapter }));
      api.addCommand(makeDbSeedCommand({ adapter: prismaAdapter }));
      api.addCommand(makeDbInspectCommand({ adapter: prismaAdapter }));
    },
  };
}
