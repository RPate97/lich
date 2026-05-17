export type RuleStatus = 'pass' | 'fail' | 'skip';

export interface RuleResult {
  status: RuleStatus;
  message?: string;
}

export interface RuleContext {
  projectRoot: string;
}

export interface Rule {
  id: string;
  describe: string;
  check(ctx: RuleContext): Promise<RuleResult>;
}

export interface RuleRunEntry {
  id: string;
  describe: string;
  result: RuleResult;
}
