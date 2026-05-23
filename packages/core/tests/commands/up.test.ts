import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip, withDockerStack } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeUpCommand } from '../../src/commands/up';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, composeProjectName, networkName, volumeName } from '../../src/compose/naming';
import { pgService } from '@lich/plugin-postgres';
import type { OwnedService, Service } from '../../src/services/types';
import type { PortlessAdapter } from '@lich/plugin-portless';
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
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

function cleanup(key: string) {
  spawnSync('docker', ['rm', '-f', containerName(key, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(key, 'postgres')], { stdio: 'ignore' });
  // Compose creates a default network `<project>_default` for every up call;
  // remove it so repeated test runs don't exhaust docker's address pools.
  // LEV-202: prefer `compose down --remove-orphans` over per-name removal so
  // ANY network the project created (default or otherwise) is freed in one
  // call. Falls through to the legacy name-based rm so existing assertions
  // that don't go through compose still get cleaned up.
  const projectName = composeProjectName(key);
  spawnSync(
    'docker',
    ['compose', '-p', projectName, 'down', '--volumes', '--remove-orphans', '--timeout', '5'],
    { stdio: 'ignore' },
  );
  spawnSync('docker', ['network', 'rm', `${projectName}_default`], { stdio: 'ignore' });
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describe('lich up (unit, mocked compose)', () => {
  it('errors NO_PROJECT when cwd is outside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-outside-')));
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a lich project/i);
  });

  it('emits a compose file under .lich/<key>/docker-compose.yml and calls up({detach,waitForHealthy})', async () => {
    const { factory, constructed, calls } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
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
      '.lich',
      result.key,
      'docker-compose.yml',
    );
    expect(existsSync(expectedPath)).toBe(true);
    const yaml = readFileSync(expectedPath, 'utf8');
    expect(yaml).toContain(`name: ${composeProjectName(result.key)}`);
    expect(yaml).toContain(`container_name: ${containerName(result.key, 'postgres')}`);

    // Runner constructed with project name + compose file.
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.projectName).toBe(composeProjectName(result.key));
    expect(constructed[0]!.composeFile).toBe(expectedPath);

    // Exactly one `up` call with detach + waitForHealthy.
    const ups = calls.filter((c) => c.op === 'up');
    expect(ups).toHaveLength(1);
    expect(ups[0]!.args[0]).toEqual({ detach: true, waitForHealthy: true });

    // Result shape preserved + compose summary added.
    expect(result.containers).toContain(containerName(result.key, 'postgres'));
    expect(result.compose).toEqual({
      projectName: composeProjectName(result.key),
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
    const cmd = makeUpCommand(() => registry, {
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
    expect(entry!.containers).toEqual([containerName(result.key, 'postgres')]);
  });

  it('second run reuses ports and calls up again (idempotent)', async () => {
    const { factory, calls } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
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
    const cmd = makeUpCommand(() => registry, {
      getServices: ownedOnly,
      composeRunnerFactory: factory,
    });
    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    expect(calls.filter((c) => c.op === 'up')).toHaveLength(0);
  });

  it('LEV-241: persists startedBy from LICH_STARTED_BY env var when set', async () => {
    // Arrange: set the env var before the run.
    process.env['LICH_STARTED_BY'] = 'claude-code';
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    try {
      const result = (await cmd.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      })) as any;
      const entry = await registry.get(result.key);
      expect(entry).toBeDefined();
      expect(entry!.startedBy).toBe('claude-code');
    } finally {
      delete process.env['LICH_STARTED_BY'];
    }
  });

  it('LEV-241: startedBy is undefined in registry when LICH_STARTED_BY is unset', async () => {
    // Ensure the var is absent for this test.
    delete process.env['LICH_STARTED_BY'];
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
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
    expect(entry!.startedBy).toBeUndefined();
  });

  it('LEV-241: second run preserves original startedBy even when LICH_STARTED_BY is unset', async () => {
    // First run with the env var set.
    process.env['LICH_STARTED_BY'] = 'cursor';
    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    try {
      await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });
    } finally {
      delete process.env['LICH_STARTED_BY'];
    }

    // Second run without the env var — attribution must not be overwritten.
    const result2 = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    const entry = await registry.get(result2.key);
    expect(entry).toBeDefined();
    expect(entry!.startedBy).toBe('cursor');
  });

  it('appends getPluginOwnedServices entries onto the merged service list (post-LEV-154)', async () => {
    // Simulates how the dispatcher wires `bootPlugins().ownedServices`
    // through to `dev` post-LEV-154 so plugins like `@lich/plugin-next`
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
    const cmd = makeUpCommand(() => registry, {
      // No built-in docker services for this test — keep the focus on the
      // owned-merge path.
      getServices: () => [],
      getPluginOwnedServices: () => [pluginOwned],
      composeRunnerFactory: factory,
      // LEV-194: detached path probes the allocated port; the `sh -c echo`
      // command exits immediately so no listener appears. Short budget so the
      // probe times out fast and the test doesn't hang on the default 10s.
      readinessTimeoutMs: 100,
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
    // LEV-194 — the detached runner reports pids + readiness instead of the
    // foreground runner's exit codes.
    expect(result.detached).toBe(true);
    expect(result.owned.pids['plugin-owned']).toBeGreaterThan(0);
    expect(result.owned.readiness['plugin-owned']).toBe('timeout');
  });
});

describeIfDocker('lich up (integration with real docker compose)', () => {
  it('first run brings up postgres via docker compose and persists registry', async () => {
    // LEV-202 — wrap the body in `withDockerStack` so the compose stack is
    // torn down in a `finally` even if the assertions throw, before
    // `afterEach`'s `cleanup()` runs. Double-cleanup is safe (compose down
    // is idempotent) but the wrapper survives certain failure modes that
    // bypass per-test hooks (timeouts, unhandled rejections).
    const wtKey = computeWorktreeKey(projectDir);
    await withDockerStack({ projectName: composeProjectName(wtKey) }, async () => {
      const cmd = makeUpCommand(() => registry, { getServices: onlyPostgres });
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
    });
  }, 180_000);
});

// Portless integration tests deliberately avoid docker so they exercise the URL
// registration path without requiring the daemon. We achieve this by injecting
// `getServices` that returns only owned services (no DockerService entries),
// which causes the docker loop in `dev` to be a no-op.
describe('lich up — portless integration', () => {
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
    writeFileSync(join(projectDir, 'lich.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: true });
    const web = mkOwnedWeb(projectDir);
    const worker = mkOwnedWorker(projectDir);
    const getServices = (): Service[] => [web, worker];

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
      // LEV-194: services are quick-exit `sh -c echo` commands with port
      // names; no listener appears so the detached probe would otherwise
      // burn the default 10s budget.
      readinessTimeoutMs: 100,
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
    writeFileSync(join(projectDir, 'lich.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: false });
    const web = mkOwnedWeb(projectDir);
    const getServices = (): Service[] => [web];

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
      // LEV-194: services are quick-exit `sh -c echo` commands with port
      // names; no listener appears so the detached probe would otherwise
      // burn the default 10s budget.
      readinessTimeoutMs: 100,
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
    writeFileSync(join(projectDir, 'lich.config.ts'), 'export default { name: "myapp" };');
    const adapter = makeMockAdapter({ available: true });
    const worker = mkOwnedWorker(projectDir);
    const getServices = (): Service[] => [worker];

    const { factory } = makeMockComposeFactory();
    const cmd = makeUpCommand(() => registry, {
      getServices,
      getPortlessAdapter: () => adapter,
      composeRunnerFactory: factory,
      // LEV-194: services are quick-exit `sh -c echo` commands with port
      // names; no listener appears so the detached probe would otherwise
      // burn the default 10s budget.
      readinessTimeoutMs: 100,
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
