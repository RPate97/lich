import { describe, test, expect } from 'vitest';
import { maybeRouteToSandbox } from '../../../src/sandbox/command-routing.js';
import type { RouteContext } from '../../../src/sandbox/command-routing.js';

export class FakeRuntime {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async down(...args: unknown[]) { this.calls.push({ method: 'down', args }); return undefined; }
  async exec(...args: unknown[]) { this.calls.push({ method: 'exec', args }); return { exitCode: 0, stdout: '', stderr: '' }; }
}

const worktree = { id: 'wt1', path: '/work/tree', stack_id: 'stack-wt1', name: 'tree' } as any;
const sandboxSnap = { sandbox: true, active_profile: 'dev' } as any;

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
      kind: 'exec',
      snapshot: sandboxSnap,
      runtime: r as any,
    }))).rejects.toThrow(/not yet implemented/);
  });
});

describe('maybeRouteToSandbox — down branch', () => {
  test('calls runtime.down with purge:false and returns stopped message', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'down',
      snapshot: sandboxSnap,
      argv: { purge: false },
      runtime: r as any,
    }));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.message).toMatch(/stopped/i);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.method).toBe('down');
    const [rtCtx, opts] = r.calls[0]!.args as [unknown, unknown];
    expect((rtCtx as any).worktreeId).toBe('wt1');
    expect((rtCtx as any).profileName).toBe('dev');
    expect(opts).toEqual({ purge: false });
  });

  test('calls runtime.down with purge:true and returns destroyed message', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'down',
      snapshot: sandboxSnap,
      argv: { purge: true },
      runtime: r as any,
    }));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(result!.message).toMatch(/destroyed/i);
    expect(r.calls[0]!.args[1]).toEqual({ purge: true });
  });

  test('treats missing argv as purge:false', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'down',
      snapshot: sandboxSnap,
      runtime: r as any,
    }));
    expect(result!.message).toMatch(/stopped/i);
    expect(r.calls[0]!.args[1]).toEqual({ purge: false });
  });
});
