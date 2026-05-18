import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/compose/naming';
import { pgService } from '@levelzero/plugin-postgres';
import type { OwnedService, Service } from '../../src/services/types';
import type { PortlessAdapter } from '@levelzero/plugin-portless';
import type { ComposeRunner } from '../../src/compose/runner';

// Tests inject `[pgService]` explicitly: the default `getBuiltinServices()`
// now also returns api+web OwnedServices (LEV-90) which would try to spawn
// `bun run dev` in `apps/api`/`apps/web` directories that don't exist in
// these tmpdir fixtures.
const onlyPostgres = (): Service[] => [pgService];

/**
 * Mock compose runner factory. Records the (projectName, composeFile) pair
 * each call constructs with, plus every `up`/`down`/`ps`/`logs`/`exec` call
 * the runner receives. All operations succeed with empty output — none of
 * the dev/stop/reset code paths read return values besides `ps`.
 */
function makeMockComposeFactory() {
  const constructed: Array<{ projectName: string; composeFile: string }> = [];
  const calls: Array<{ op: string; args: unknown[]; projectName: string; composeFile: string }> =
    [];
  const factory = (projectName: string, composeFile: string): ComposeRunner => {
    constructed.push({ projectName, composeFile });
    const record = (op: string, ...args: unknown[]) => {
      calls.push({ op, args, projectName, composeFile });
    };
    return {
      async up(o) {
        record('up', o);
      },
      async down(o) {
        record('down', o);
      },
      async ps() {
        record('ps');
        return [];
      },
      async logs(svc, o) {
        record('logs', svc, o);
        return '';
      },
      async exec(svc, cmd) {
        record('exec', svc, cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
  };
  return { factory, constructed, calls };
}

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
  // Compose creates a default network `<project>_default` for every up call;
  // remove it so repeated test runs don't exhaust docker's address pools.
  spawnSync('docker', ['network', 'rm', `levelzero-${key}_default`], { stdio: 'ignore' });
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describe('levelzero dev (unit, mocked compose)', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-outside-')));
    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
  });

  it('emits a compose file under .levelzero/<key>/docker-compose.yml and calls up({detach,waitForHealthy})', async () => {
    const { factory, constructed, calls } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // Compose file landed at the documented path.
    const expectedPath = join(
      projectDir,
      '.levelzero',
      result.key,
      'docker-compose.yml',
    );
    expect(existsSync(expectedPath)).toBe(true);
    const yaml = readFileSync(expectedPath, 'utf8');
    expect(yaml).toContain(`name: levelzero-${result.key}`);
    expect(yaml).toContain(`container_name: levelzero-${result.key}-postgres`);

    // Runner constructed with project name + compose file.
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.projectName).toBe(`levelzero-${result.key}`);
    expect(constructed[0]!.composeFile).toBe(expectedPath);

    // Exactly one `up` call with detach + waitForHealthy.
    const ups = calls.filter((c) => c.op === 'up');
    expect(ups).toHaveLength(1);
    expect(ups[0]!.args[0]).toEqual({ detach: true, waitForHealthy: true });

    // Result shape preserved + compose summary added.
    expect(result.containers).toContain(`levelzero-${result.key}-postgres`);
    expect(result.compose).toEqual({
      projectName: `levelzero-${result.key}`,
      file: expectedPath,
    });
    expect(result.ports.postgres).toBeGreaterThan(0);
    // LEV-187: pgService no longer publishes DATABASE_URL through the legacy
    // envContributions hook, so the dev result's `env` map is empty for
    // pgService-only stacks. The connection-string formula now lives in
    // plugin-postgres' `addEnvSource('url')` registration — Plan 16 Tier 2
    // plumbs the resolved values back into this slot.
    expect(result.env.DATABASE_URL).toBeUndefined();
  });

  it('persists ports + containers in the registry under the worktree key', async () => {
    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    const entry = await registry.get(result.key);
    expect(entry).toBeDefined();
    expect(entry!.ports.postgres).toBe(result.ports.postgres);
    expect(entry!.containers).toEqual([`levelzero-${result.key}-postgres`]);
  });

  it('second run reuses ports and calls up again (idempotent)', async () => {
    const { factory, calls } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const first = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    const second = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(second.ports.postgres).toBe(first.ports.postgres);
    expect(second.containers).toEqual(first.containers);
    // Two up calls — compose itself is the idempotency boundary.
    expect(calls.filter((c) => c.op === 'up')).toHaveLength(2);
  });

  it('skips up() when there are no docker services to start', async () => {
    const ownedOnly = (): Service[] => [];
    const { factory, calls } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices: ownedOnly,
      composeRunnerFactory: factory,
    });
    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    expect(calls.filter((c) => c.op === 'up')).toHaveLength(0);
  });

  it('appends getPluginOwnedServices entries onto the merged service list (post-LEV-154)', async () => {
    // Simulates how the dispatcher wires `bootPlugins().ownedServices`
    // through to `dev` post-LEV-154 so plugins like `@levelzero/plugin-next`
    // contribute owned services that `dev` brings up alongside built-ins.
    const pluginOwned: OwnedService = {
      name: 'plugin-owned',
      kind: 'owned',
      portNames: ['plugin-port'],
      cwd: projectDir,
      // Quick-exit so the owned runner returns immediately; we only care that
      // the env contribution + port allocation reflect the plugin-supplied
      // service.
      command: 'sh -c "echo plugin-up"',
      envContributions: (ports) => ({
        PLUGIN_URL: `http://localhost:${ports['plugin-port']}`,
      }),
    };
    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      // No built-in docker services for this test — keep the focus on the
      // owned-merge path.
      getServices: () => [],
      getPluginOwnedServices: () => [pluginOwned],
      composeRunnerFactory: factory,
    });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // The plugin-contributed port was allocated, and its envContributions ran
    // against the live port map — proving the service made it through the
    // merge into the runner's allServices view.
    expect(result.ports['plugin-port']).toBeGreaterThan(0);
    expect(result.env.PLUGIN_URL).toBe(
      `http://localhost:${result.ports['plugin-port']}`,
    );
  });
});

describeIfDocker('levelzero dev (integration with real docker compose)', () => {
  it('first run brings up postgres via docker compose and persists registry', async () => {
    const cmd = makeDevCommand(() => registry, { getServices: onlyPostgres });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.path).toBe(projectDir);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54000);
    expect(result.ports.postgres).toBeLessThanOrEqual(54999);
    // LEV-187: pgService no longer publishes DATABASE_URL through the legacy
    // envContributions hook — the postgres plugin's `addEnvSource('url')` is
    // the new source of truth. Plan 16 Tier 2 plumbs resolved values back
    // into `result.env`.
    expect(result.env.DATABASE_URL).toBeUndefined();
    expect(result.containers).toContain(containerName(result.key, 'postgres'));

    const entry = await registry.get(result.key);
    expect(entry).toBeDefined();
    expect(entry!.ports.postgres).toBe(result.ports.postgres);
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

    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
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

    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
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

    const { factory } = makeMockComposeFactory();
    const cmd = makeDevCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
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
