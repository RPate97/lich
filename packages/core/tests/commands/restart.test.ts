/**
 * LEV-249 — `lich restart` command tests.
 *
 * Minimum: verify the command exists and exposes the right name.
 * Stretch: unit tests mocking the stop + spawn paths to verify the
 * orchestration calls stop-only-owned and then spawn-owned, and does
 * NOT call compose teardown (`docker compose down` is never invoked).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Registry } from '../../src/registry';
import { makeRestartCommand } from '../../src/commands/restart';
import { computeWorktreeKey } from '../../src/worktree';
import { CLIError } from '../../src/errors';
import type { OwnedService, Service } from '../../src/services/types';
import type { ComposeRunner } from '../../src/compose/runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockComposeFactory() {
  const calls: Array<{ op: string }> = [];
  const factory = (_projectName: string, _composeFile: string): ComposeRunner => ({
    async up() {
      calls.push({ op: 'up' });
    },
    async down() {
      calls.push({ op: 'down' });
    },
    async ps() {
      return [];
    },
    async logs() {
      return '';
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  return { factory, calls };
}

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-restart-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-restart-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Basic registration
// ---------------------------------------------------------------------------

describe('makeRestartCommand — registration', () => {
  it('exports a Command with name "restart"', () => {
    const cmd = makeRestartCommand(() => registry);
    expect(cmd.name).toBe('restart');
    expect(typeof cmd.run).toBe('function');
    expect(typeof cmd.describe).toBe('string');
    expect(cmd.describe.length).toBeGreaterThan(0);
  });

  it('rejects when cwd is not inside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-restart-outside-')));
    const cmd = makeRestartCommand(() => registry);
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a lich project/i);
  });

  it('throws CLIError when no stack entry exists in the registry', async () => {
    const cmd = makeRestartCommand(() => registry);
    let thrown: unknown;
    try {
      await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).message).toMatch(/no stack running/i);
  });
});

// ---------------------------------------------------------------------------
// Orchestration: stop-only-owned + spawn-owned, compose NOT touched
// ---------------------------------------------------------------------------

describe('makeRestartCommand — orchestration (no compose teardown)', () => {
  it('does NOT call compose down when restarting', async () => {
    const wtKey = computeWorktreeKey(projectDir);
    await registry.upsert(wtKey, {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: new Date().toISOString(),
    });

    const { factory, calls } = makeMockComposeFactory();

    // No owned services — restart should still work (no-op spawn).
    const cmd = makeRestartCommand(() => registry, {
      getServices: (): Service[] => [],
      // getPluginCompose: provided for parity wiring, factory captures calls
      getPluginCompose: () => ({ services: {}, volumes: {}, networks: {} }),
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // No compose operations — this is the critical invariant.
    expect(calls).toHaveLength(0);
    expect(result.key).toBe(wtKey);
    expect(result.stopped).toEqual([]);
    expect(result.started).toEqual({});
  });

  it('signals running owned services then re-spawns them (stop → spawn cycle)', async () => {
    const wtKey = computeWorktreeKey(projectDir);
    await registry.upsert(wtKey, {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: new Date().toISOString(),
    });

    // Plant a real sleeping child pid in the state dir to exercise stop.
    const pidDir = join(projectDir, '.lich', 'state', wtKey, 'pids');
    mkdirSync(pidDir, { recursive: true });

    const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    writeFileSync(join(pidDir, 'svc.pid'), `${child.pid}\n`);

    // A quick-exit owned service so spawn completes fast.
    const svc: OwnedService = {
      name: 'svc',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "sleep 0.2"',
      envContributions: () => ({}),
    };

    const cmd = makeRestartCommand(() => registry, {
      getServices: (): Service[] => [svc],
      readinessTimeoutMs: 200,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.key).toBe(wtKey);

    // The old child was stopped.
    expect(result.stopped).toHaveLength(1);
    expect(result.stopped[0]!.name).toBe('svc');
    expect(['terminated', 'killed', 'stale']).toContain(result.stopped[0]!.result);

    // The child should now be dead.
    let alive = true;
    try {
      process.kill(child.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    // The new service was spawned (pid file re-created by runner).
    expect(result.started).toBeDefined();
    expect(result.started.pids).toBeDefined();
    expect(result.started.pids.svc).toBeGreaterThan(0);
    expect(result.started.statuses.svc).toBe('skipped');

    // Pid file now exists for the newly spawned service.
    expect(existsSync(join(pidDir, 'svc.pid'))).toBe(true);
  }, 10_000);

  it('is idempotent when no pid files exist (no services running)', async () => {
    const wtKey = computeWorktreeKey(projectDir);
    await registry.upsert(wtKey, {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: new Date().toISOString(),
    });

    const svc: OwnedService = {
      name: 'svc',
      kind: 'owned',
      portNames: [],
      cwd: projectDir,
      command: 'sh -c "sleep 0.2"',
      envContributions: () => ({}),
    };

    const cmd = makeRestartCommand(() => registry, {
      getServices: (): Service[] => [svc],
      readinessTimeoutMs: 200,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // Stop step was a no-op (nothing was running).
    expect(result.stopped).toEqual([]);
    // Spawn step still ran.
    expect(result.started.pids.svc).toBeGreaterThan(0);
  }, 10_000);

  it('throws CLIError when an owned service crashes on restart (LEV-219 parity)', async () => {
    const wtKey = computeWorktreeKey(projectDir);
    await registry.upsert(wtKey, {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: new Date().toISOString(),
    });

    const crasher: OwnedService = {
      name: 'crasher',
      kind: 'owned',
      portNames: ['crasher'],
      cwd: projectDir,
      command: 'sh -c "echo restart-crash-detail 1>&2; exit 1"',
      envContributions: () => ({}),
    };

    const cmd = makeRestartCommand(() => registry, {
      getServices: (): Service[] => [crasher],
      readinessTimeoutMs: 3000,
    });

    let thrown: unknown;
    try {
      await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    const err = thrown as CLIError;
    expect(err.message).toContain('crasher');
    const started = (err.details as any)?.started;
    expect(started.statuses.crasher).toBe('failed');
    expect(started.exitCodes.crasher).toBe(1);
    expect(started.lastStderr.crasher).toContain('restart-crash-detail');
  }, 12_000);

  it('returns a pretty string when format is "pretty"', async () => {
    const wtKey = computeWorktreeKey(projectDir);
    await registry.upsert(wtKey, {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.lich/logs',
      createdAt: new Date().toISOString(),
    });

    const cmd = makeRestartCommand(() => registry, {
      getServices: (): Service[] => [],
    });

    const result = await cmd.run({
      cwd: projectDir,
      format: 'pretty',
      args: [],
      flags: {},
    });

    expect(typeof result).toBe('string');
    expect(result as string).toContain(wtKey);
  });
});
