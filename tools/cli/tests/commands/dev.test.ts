import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/docker/naming';
import type { OwnedService, Service } from '../../src/services/types';
import type { PortlessAdapter } from '../../src/adapters/portless/types';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

function cleanup(key: string) {
  spawnSync('docker', ['rm', '-f', containerName(key, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(key, 'postgres')], { stdio: 'ignore' });
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describeIfDocker('levelzero dev', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-outside-')));
    const cmd = makeDevCommand(() => registry);
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
  });

  it('first run allocates ports, starts postgres, persists registry, returns env', async () => {
    const cmd = makeDevCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;

    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.path).toBe(projectDir);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54000);
    expect(result.ports.postgres).toBeLessThanOrEqual(54999);
    expect(result.env.DATABASE_URL).toContain(`localhost:${result.ports.postgres}`);
    expect(result.containers).toContain(containerName(result.key, 'postgres'));
    expect(result.services.find((s: any) => s.name === 'postgres')).toBeDefined();

    const entry = await registry.get(result.key);
    expect(entry).toBeDefined();
    expect(entry!.ports.postgres).toBe(result.ports.postgres);
  }, 120_000);

  it('second run is idempotent (same ports, same container, no errors)', async () => {
    const cmd = makeDevCommand(() => registry);
    const first = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    const second = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;

    expect(second.key).toBe(first.key);
    expect(second.ports.postgres).toBe(first.ports.postgres);
    expect(second.containers).toEqual(first.containers);
  }, 180_000);
});

// Portless integration tests deliberately avoid docker so they exercise the URL
// registration path without requiring the daemon. We achieve this by injecting
// `getServices` that returns only owned services (no DockerService entries),
// which causes the docker loop in `dev` to be a no-op.
describe('levelzero dev — portless integration', () => {
  function makeMockAdapter(opts: { available: boolean }): PortlessAdapter & {
    registerCalls: Array<{ host: string; target: string }>;
  } {
    const registerCalls: Array<{ host: string; target: string }> = [];
    return {
      name: 'mock',
      registerCalls,
      available: vi.fn(async () => opts.available),
      register: vi.fn(async (input: { host: string; target: string }) => {
        registerCalls.push(input);
      }),
      unregister: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    };
  }

  function mkOwnedWeb(cwd: string): OwnedService {
    return {
      name: 'web',
      kind: 'owned',
      portNames: ['web'],
      cwd,
      // Quick-exit; the test only cares about URL registration.
      command: 'sh -c "echo web-up"',
      envContributions: () => ({}),
      urlName: 'web',
    };
  }

  function mkOwnedWorker(cwd: string): OwnedService {
    return {
      name: 'worker',
      kind: 'owned',
      portNames: ['worker'],
      cwd,
      command: 'sh -c "echo worker-up"',
      envContributions: () => ({}),
      // intentionally no urlName: should be skipped by portless registration
    };
  }

  it('registers URLs and persists StackEntry.urls when portless.available()=true', async () => {
    writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: true });
    const web = mkOwnedWeb(projectDir);
    const worker = mkOwnedWorker(projectDir);
    const getServices = (): Service[] => [web, worker];

    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // available() probed exactly once
    expect(adapter.available).toHaveBeenCalledTimes(1);
    // register() called only for the urlName-bearing service
    expect(adapter.registerCalls).toHaveLength(1);
    const reg = adapter.registerCalls[0]!;
    expect(reg.host).toContain('.web.myapp.localhost');
    expect(reg.target).toBe(`http://localhost:${result.ports.web}`);

    // entry.urls populated, keyed by service name, with the portless https URL
    const entry = await registry.get(result.key);
    expect(entry).toBeDefined();
    expect(entry!.urls.web).toBe(`https://${reg.host}`);
    expect(entry!.urls.worker).toBeUndefined();
  }, 30_000);

  it('skips registration and leaves urls empty when portless.available()=false', async () => {
    writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: false });
    const web = mkOwnedWeb(projectDir);
    const getServices = (): Service[] => [web];

    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // probed but never registered
    expect(adapter.available).toHaveBeenCalledTimes(1);
    expect(adapter.register).not.toHaveBeenCalled();

    const entry = await registry.get(result.key);
    expect(entry).toBeDefined();
    expect(entry!.urls).toEqual({});
  }, 30_000);

  it('services without urlName are unaffected (no registration, no urls entry)', async () => {
    writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: true });
    const worker = mkOwnedWorker(projectDir);
    const getServices = (): Service[] => [worker];

    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(adapter.register).not.toHaveBeenCalled();
    const entry = await registry.get(result.key);
    expect(entry!.urls).toEqual({});
  }, 30_000);
});
