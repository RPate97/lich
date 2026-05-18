import { RuleRegistry } from './registry';
import { makeRouteCoverageRule, routeCoverageRule } from './rules/route-coverage';
import { schemaMigrationRule } from './rules/schema-migration';
import { typeClientFreshnessRule } from './rules/type-client-freshness';
import type { BackendAdapter } from '../adapters/backend/types';

export interface BuiltinRulesOptions {
  /**
   * Backend adapter wired into the route-coverage rule (LEV-174). When
   * absent the rule registers in skip-only mode (still reports a clean
   * `[SKIP] route-coverage` line under `levelzero check` rather than
   * crashing). The CLI dispatcher passes the merged registry's active
   * `backend` impl when one is loaded.
   */
  backendAdapter?: BackendAdapter;
}

export function getBuiltinRules(opts?: BuiltinRulesOptions): RuleRegistry {
  const r = new RuleRegistry();
  // Prefer the fully-wired variant when a backend adapter is supplied;
  // fall back to the bare default rule (which itself returns skip when no
  // adapter is present) for the plugin-less dispatch path.
  if (opts?.backendAdapter) {
    r.register(makeRouteCoverageRule({ backendAdapter: opts.backendAdapter }));
  } else {
    r.register(routeCoverageRule);
  }
  r.register(schemaMigrationRule);
  r.register(typeClientFreshnessRule);
  return r;
}
