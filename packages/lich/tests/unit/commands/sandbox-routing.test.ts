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
      kind: 'stacks',
      snapshot: sandboxSnap,
      runtime: r as any,
    }))).rejects.toThrow(/not yet implemented/);
  });
});

describe('maybeRouteToSandbox — exec branch', () => {
  test('proxies the user argv as `lich exec -- ...` with inheritStdio', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'exec',
      snapshot: sandboxSnap,
      argv: ['api', 'ls', '-la'],
      runtime: r as any,
    }));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.method).toBe('exec');
    const [rtCtx, args, opts] = r.calls[0]!.args as [unknown, string[], unknown];
    expect((rtCtx as any).worktreeId).toBe('wt1');
    expect(args).toEqual(['lich', 'exec', '--', 'api', 'ls', '-la']);
    expect(opts).toEqual({ inheritStdio: true });
  });

  test('propagates the exec exit code', async () => {
    const r = new FakeRuntime();
    r.exec = async () => ({ exitCode: 42, stdout: '', stderr: '' });
    const result = await maybeRouteToSandbox(ctx({
      kind: 'exec',
      snapshot: sandboxSnap,
      argv: ['api', 'false'],
      runtime: r as any,
    }));
    expect(result!.exitCode).toBe(42);
  });

  test('returns null when not a sandbox stack (host path)', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'exec',
      snapshot: { sandbox: false } as any,
      argv: ['api', 'ls'],
      runtime: r as any,
    }));
    expect(result).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});

describe('maybeRouteToSandbox — logs branch', () => {
  test('proxies `lich logs` with service args + flags, no timeout when following', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'logs',
      snapshot: sandboxSnap,
      argv: { sources: ['api'], follow: true },
      runtime: r as any,
    }));
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.method).toBe('exec');
    const [, args, opts] = r.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(['lich', 'logs', 'api', '--follow']);
    expect(opts.inheritStdio).toBe(true);
    expect(opts.timeoutMs).toBeUndefined();
  });

  test('non-follow logs gets a finite timeout and --no-follow', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'logs',
      snapshot: sandboxSnap,
      argv: { sources: [], follow: false, tail: 50 },
      runtime: r as any,
    }));
    const [, args, opts] = r.calls[0]!.args as [unknown, string[], any];
    expect(args).toEqual(['lich', 'logs', '--no-follow', '--tail', '50']);
    expect(opts.timeoutMs).toBe(30_000);
    expect(result!.exitCode).toBe(0);
  });

  test('returns null when not a sandbox stack', async () => {
    const r = new FakeRuntime();
    const result = await maybeRouteToSandbox(ctx({
      kind: 'logs',
      snapshot: { sandbox: false } as any,
      argv: { sources: ['api'], follow: false },
      runtime: r as any,
    }));
    expect(result).toBeNull();
    expect(r.calls).toHaveLength(0);
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
