import type { Rule } from '../types';

export const routeCoverageRule: Rule = {
  id: 'route-coverage',
  describe: 'every Hono route has an integration test',
  check: async () => ({ status: 'skip', message: 'route manifest not yet available (plan 09)' }),
};
