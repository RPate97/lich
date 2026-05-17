import { describe, it, expect } from 'vitest';
import { RuleRegistry } from '../../src/check/registry';
import type { Rule, RuleResult } from '../../src/check/types';

const okRule: Rule = {
  id: 'always-ok',
  describe: 'passes always',
  check: async (): Promise<RuleResult> => ({ status: 'pass' }),
};

const failRule: Rule = {
  id: 'always-fail',
  describe: 'fails always',
  check: async (): Promise<RuleResult> => ({ status: 'fail', message: 'because' }),
};

const skipRule: Rule = {
  id: 'always-skip',
  describe: 'skips always',
  check: async (): Promise<RuleResult> => ({ status: 'skip', message: 'prereq missing' }),
};

describe('RuleRegistry', () => {
  it('registers and lists rules in insertion order', () => {
    const r = new RuleRegistry();
    r.register(okRule);
    r.register(failRule);
    expect(r.listAll().map((rule) => rule.id)).toEqual(['always-ok', 'always-fail']);
  });

  it('runAll returns one entry per rule, in order', async () => {
    const r = new RuleRegistry();
    r.register(okRule);
    r.register(failRule);
    r.register(skipRule);
    const results = await r.runAll({ projectRoot: '/tmp' });
    expect(results.map((x) => x.id)).toEqual(['always-ok', 'always-fail', 'always-skip']);
    expect(results[0]!.result.status).toBe('pass');
    expect(results[1]!.result.status).toBe('fail');
    expect(results[2]!.result.status).toBe('skip');
  });

  it('runAll wraps thrown errors as fail results', async () => {
    const r = new RuleRegistry();
    r.register({
      id: 'throws',
      describe: 'throws',
      check: async () => { throw new Error('boom'); },
    });
    const [r0] = await r.runAll({ projectRoot: '/tmp' });
    expect(r0!.result.status).toBe('fail');
    expect(r0!.result.message).toContain('boom');
  });

  it('duplicate rule id throws on register', () => {
    const r = new RuleRegistry();
    r.register(okRule);
    expect(() => r.register({ ...okRule })).toThrow(/already registered/i);
  });
});
