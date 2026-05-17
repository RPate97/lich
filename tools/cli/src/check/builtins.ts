import { RuleRegistry } from './registry';
import { routeCoverageRule } from './rules/route-coverage';
import { schemaMigrationRule } from './rules/schema-migration';
import { typeClientFreshnessRule } from './rules/type-client-freshness';

export function getBuiltinRules(): RuleRegistry {
  const r = new RuleRegistry();
  r.register(routeCoverageRule);
  r.register(schemaMigrationRule);
  r.register(typeClientFreshnessRule);
  return r;
}
