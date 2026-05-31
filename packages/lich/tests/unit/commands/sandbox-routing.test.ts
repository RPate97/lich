import { describe, test, expect } from 'vitest';
import { maybeRouteToSandbox } from '../../../src/sandbox/command-routing.js';
import type { RouteContext } from '../../../src/sandbox/command-routing.js';

// FakeRuntime records calls; per-command tasks will extend the assertions below.
export class FakeRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async down(...args: unknown[]) { this.calls.push({ method: 'down', args }); return undefined; }
  async exec(...args: unknown[]) { this.calls.push({ method: 'exec', args }); return { exitCode: 0, stdout: '', stderr: '' }; }
}

const worktree = { id: 'wt1', path: '/work/tree', stack_id: 'stack-wt1', name: 'tree' } as any;

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    kind: 'down',
    snapshot: null,
    worktree,
    lichYamlPath: '/work/tree/lich.yaml',
    ...over,
  };
}

describe('maybeRouteToSandbox skeleton', () => {
  test('returns null when snapshot has no sandbox marker', async () => {
    expect(await maybeRouteToSandbox(ctx({ snapshot: null }))).toBeNull();
    expect(await maybeRouteToSandbox(ctx({ snapshot: {} as any }))).toBeNull();
    expect(await maybeRouteToSandbox(ctx({ snapshot: { sandbox: false } as any }))).toBeNull();
  });

  test('throws for marker-present kind that has no branch yet', async () => {
    const r = new FakeRuntime();
    await expect(maybeRouteToSandbox(ctx({
      kind: 'down',
      snapshot: { sandbox: true, active_profile: 'dev' } as any,
      runtime: r as any,
    }))).rejects.toThrow(/not yet implemented/);
  });
});
