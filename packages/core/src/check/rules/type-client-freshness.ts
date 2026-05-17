import type { Rule } from '../types';

export const typeClientFreshnessRule: Rule = {
  id: 'type-client-freshness',
  describe: 'api-client/types match the current Hono routes',
  check: async () => ({ status: 'skip', message: 'codegen not yet implemented (plan 09)' }),
};
