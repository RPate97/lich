import { describe, test, expect } from 'vitest';
import { isSandboxStack, sandboxCtxFromSnapshot } from '../../../src/sandbox/marker.js';
const worktree = { id: 'wt1', path: '/work/tree', stack_id: 'stack-wt1', name: 'tree' };
describe('sandbox marker', () => {
  test('isSandboxStack true only when flag set', () => {
    expect(isSandboxStack({ sandbox: true } as any)).toBe(true);
    expect(isSandboxStack({} as any)).toBe(false);
    expect(isSandboxStack(null as any)).toBe(false);
  });
  test('reconstructs a RuntimeContext', () => {
    const ctx = sandboxCtxFromSnapshot(worktree as any, { sandbox: true, active_profile: 'dev:heavy' } as any, '/work/tree/lich.yaml');
    expect(ctx).toEqual({ worktreeId: 'wt1', worktreePath: '/work/tree', lichYamlPath: '/work/tree/lich.yaml', profileName: 'dev:heavy' });
  });
  test('defaults profile to "default"', () => {
    expect(sandboxCtxFromSnapshot(worktree as any, { sandbox: true } as any, '/x/lich.yaml').profileName).toBe('default');
  });
});
