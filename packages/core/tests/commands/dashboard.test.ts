import { describe, it, expect } from 'vitest';
import { makeDashboardCommand } from '../../src/commands/dashboard';

describe('makeDashboardCommand', () => {
  it('produces a command named "dashboard"', () => {
    const cmd = makeDashboardCommand(() => '/tmp/registry.json');
    expect(cmd.name).toBe('dashboard');
    expect(cmd.describe.length).toBeGreaterThan(0);
  });
});
