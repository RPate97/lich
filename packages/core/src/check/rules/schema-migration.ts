import type { Rule } from '../types';

export const schemaMigrationRule: Rule = {
  id: 'schema-migration-consistency',
  describe: 'Prisma schema matches latest migration',
  check: async () => ({ status: 'skip', message: 'Prisma adapter not yet wired into check (plan 05 + follow-on)' }),
};
