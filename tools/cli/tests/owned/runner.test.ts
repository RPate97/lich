import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnedServices } from '../../src/owned/runner';
import type { OwnedService, StackContext } from '../../src/services/types';

let tmp: string;
let logDir: string;
let ctx: StackContext;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-runner-')));
  logDir = join(tmp, 'logs');
  ctx = { worktreeKey: 'a1b2c3d4e5f6', worktreePath: tmp, branch: 'main' };
});

function readJsonl(path: string): Array<{ message: string; stream: string; level: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('runOwnedServices', () => {
  it('returns immediately with done resolved when services list is empty', async () => {
    const handle = await runOwnedServices([], ctx, {}, {}, { logDir });
    const { exitCodes } = await handle.done;
    expect(exitCodes).toEqual({});
  });

  it('spawns a single service, tees its stdout to <name>.jsonl', async () => {
    const svc: OwnedService = {
      name: 'echo',
      kind: 'owned',
      portNames: [],
      cwd: tmp,
      command: 'echo hello-from-echo',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServices([svc], ctx, {}, {}, { logDir });
    const { exitCodes } = await handle.done;
    expect(exitCodes['echo']).toBe(0);

    const lines = readJsonl(join(logDir, 'echo.jsonl'));
    expect(lines.some((l) => l.message.includes('hello-from-echo') && l.stream === 'stdout')).toBe(true);
  }, 15_000);

  it('captures stderr with level=error', async () => {
    const svc: OwnedService = {
      name: 'noisy',
      kind: 'owned',
      portNames: [],
      cwd: tmp,
      command: 'sh -c "echo to-stdout; echo to-stderr 1>&2"',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServices([svc], ctx, {}, {}, { logDir });
    await handle.done;
    const lines = readJsonl(join(logDir, 'noisy.jsonl'));
    expect(lines.some((l) => l.message.includes('to-stdout') && l.stream === 'stdout' && l.level === 'info')).toBe(true);
    expect(lines.some((l) => l.message.includes('to-stderr') && l.stream === 'stderr' && l.level === 'error')).toBe(true);
  }, 15_000);

  it('injects per-service env (base env + envContributions)', async () => {
    const svc: OwnedService = {
      name: 'envcheck',
      kind: 'owned',
      portNames: ['api'],
      cwd: tmp,
      command: 'sh -c "echo BASE=$LZ_BASE API_URL=$API_URL"',
      envContributions: (ports) => ({ API_URL: `http://localhost:${ports.api}` }),
    };
    const handle = await runOwnedServices(
      [svc],
      ctx,
      { api: 54100 },
      { LZ_BASE: 'shared-value' },
      { logDir },
    );
    await handle.done;
    const lines = readJsonl(join(logDir, 'envcheck.jsonl'));
    const msg = lines.find((l) => l.message.includes('BASE='))?.message ?? '';
    expect(msg).toContain('BASE=shared-value');
    expect(msg).toContain('API_URL=http://localhost:54100');
  }, 15_000);

  it('topologically sorts services by dependsOn', async () => {
    const a: OwnedService = { name: 'a', kind: 'owned', portNames: [], cwd: tmp, command: 'echo a', envContributions: () => ({}) };
    const b: OwnedService = { name: 'b', kind: 'owned', portNames: [], cwd: tmp, command: 'echo b', envContributions: () => ({}), dependsOn: ['a'] };
    const c: OwnedService = { name: 'c', kind: 'owned', portNames: [], cwd: tmp, command: 'echo c', envContributions: () => ({}), dependsOn: ['b'] };
    const handle = await runOwnedServices([c, a, b], ctx, {}, {}, { logDir });
    await handle.done;
    expect(Object.keys(handle.pids)).toEqual(['a', 'b', 'c']);
  }, 15_000);

  it('stop() kills running children promptly', async () => {
    const svc: OwnedService = {
      name: 'sleeper',
      kind: 'owned',
      portNames: [],
      cwd: tmp,
      command: 'sh -c "sleep 30"',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServices([svc], ctx, {}, {}, { logDir });
    const start = Date.now();
    await handle.stop();
    const { exitCodes } = await handle.done;
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(exitCodes['sleeper']).not.toBe(0);
  }, 10_000);
});
