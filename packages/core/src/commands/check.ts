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
      const out = {
        ok: fail === 0,
        summary: { pass, fail, skip, total: results.length },
        results,
      };
      if (ctx.format === 'json') return out;
      const lines: string[] = [];
      for (const r of results) {
        const status = r.result.status.toUpperCase();
        const msg = r.result.message ? ` — ${r.result.message}` : '';
        lines.push(`[${status}] ${r.id}${msg}`);
      }
      lines.push('');
      lines.push(`summary: ${pass} pass, ${fail} fail, ${skip} skip (${results.length} total)`);
      return lines.join('\n') + '\n';
    },
  };
}
