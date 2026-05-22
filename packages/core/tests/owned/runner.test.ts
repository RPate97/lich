import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runOwnedServices,
  runOwnedServicesDetached,
} from '../../src/owned/runner';
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

describe('runOwnedServicesDetached — failure surfacing (LEV-219)', () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = join(tmp, 'pids');
  });

  it('reports status=failed and a non-zero exit code when a service crashes on startup', async () => {
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: ['crasher'],
      cwd: tmp,
      command: 'sh -c "echo boom-on-stderr 1>&2; exit 1"',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServicesDetached(
      [crasher],
      ctx,
      { crasher: 54900 },
      {},
      { logDir, pidDir, readinessTimeoutMs: 3000 },
    );

    expect(handle.statuses['crasher']).toBe('failed');
    expect(handle.exitCodes['crasher']).toBe(1);
    // Back-compat alias still reflects the same status.
    expect(handle.readiness['crasher']).toBe('failed');
  }, 10_000);

  it('captures the last lines of the crashed service log as lastLogTail', async () => {
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: [],
      cwd: tmp,
      command: 'sh -c "echo first-line; echo crash-reason-here 1>&2; exit 2"',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServicesDetached(
      [crasher],
      ctx,
      {},
      {},
      { logDir, pidDir, readinessTimeoutMs: 3000 },
    );

    expect(handle.statuses['crasher']).toBe('failed');
    expect(handle.exitCodes['crasher']).toBe(2);
    expect(handle.lastLogTail['crasher']).toContain('crash-reason-here');
  }, 10_000);

  it('distinguishes timeout (still running, no probe) from failed (exited non-zero)', async () => {
    // Still-running service that never binds its port -> timeout.
    const stuck: OwnedService = {
      name: 'stuck',
      kind: 'owned',
      portNames: ['stuck'],
      cwd: tmp,
      command: 'sh -c "sleep 30"',
      envContributions: () => ({}),
    };
    // Crashes immediately -> failed.
    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: ['crasher'],
      cwd: tmp,
      command: 'sh -c "exit 3"',
      envContributions: () => ({}),
    };
    const handle = await runOwnedServicesDetached(
      [stuck, crasher],
      ctx,
      { stuck: 54910, crasher: 54911 },
      {},
      { logDir, pidDir, readinessTimeoutMs: 300 },
    );

    expect(handle.statuses['stuck']).toBe('timeout');
    expect(handle.statuses['crasher']).toBe('failed');
    expect(handle.exitCodes['crasher']).toBe(3);
    expect(handle.exitCodes['stuck']).toBeUndefined();

    // Clean up the still-running sleeper.
    const pid = handle.pids['stuck'];
    if (typeof pid === 'number' && Number.isFinite(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 10_000);

  it('does not block on the readiness deadline when a service is still timing out', async () => {
    const stuck: OwnedService = {
      name: 'stuck',
      kind: 'owned',
      portNames: ['stuck'],
      cwd: tmp,
      command: 'sh -c "sleep 30"',
      envContributions: () => ({}),
    };
    const start = Date.now();
    const handle = await runOwnedServicesDetached(
      [stuck],
      ctx,
      { stuck: 54920 },
      {},
      { logDir, pidDir, readinessTimeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    // Spawn + a single 200ms probe budget — well under a second.
    expect(elapsed).toBeLessThan(1500);
    expect(handle.statuses['stuck']).toBe('timeout');

    const pid = handle.pids['stuck'];
    if (typeof pid === 'number' && Number.isFinite(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 10_000);
});
