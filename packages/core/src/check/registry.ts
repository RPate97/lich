import type { Rule, RuleContext, RuleRunEntry } from './types';

export class RuleRegistry {
  private readonly rules: Rule[] = [];
  private readonly seen = new Set<string>();

  register(rule: Rule): void {
    if (this.seen.has(rule.id)) {
      throw new Error(`rule already registered: ${rule.id}`);
    }
    this.seen.add(rule.id);
    this.rules.push(rule);
  }

  listAll(): Rule[] {
    return [...this.rules];
  }

  async runAll(ctx: RuleContext): Promise<RuleRunEntry[]> {
    const out: RuleRunEntry[] = [];
    for (const rule of this.rules) {
      try {
        const result = await rule.check(ctx);
        out.push({ id: rule.id, describe: rule.describe, result });
      } catch (err: unknown) {
        out.push({
          id: rule.id,
          describe: rule.describe,
          result: {
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    return out;
  }
}
