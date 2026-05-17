import { resolveStackContext } from '../services/context';
import { getBuiltinRules } from '../check/builtins';
import { RuleRegistry } from '../check/registry';
import type { Command } from './types';

export interface CheckOptions {
  /** Override the rules used; defaults to getBuiltinRules. */
  getRules?: () => RuleRegistry;
}

export function makeCheckCommand(opts?: CheckOptions): Command {
  const getRules = opts?.getRules ?? getBuiltinRules;
  return {
    name: 'check',
    describe: 'Run framework-level conformance rules',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const registry = getRules();
      const results = await registry.runAll({ projectRoot: stackCtx.worktreePath });
      const pass = results.filter((r) => r.result.status === 'pass').length;
      const fail = results.filter((r) => r.result.status === 'fail').length;
      const skip = results.filter((r) => r.result.status === 'skip').length;
      return {
        ok: fail === 0,
        summary: { pass, fail, skip, total: results.length },
        results,
      };
    },
  };
}
