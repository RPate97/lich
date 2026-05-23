import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { dockerOrSkip, isContainerRunning, withDockerStack } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { makeStopCommand } from '../../src/commands/stop';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, composeProjectName, networkName, volumeName } from '../../src/compose/naming';
import { pgService } from '@lich/plugin-postgres';
import type { Service } from '../../src/services/types';
import type { ComposeRunner } from '../../src/compose/runner';

// Default builtins now include api+web OwnedServices (LEV-90). Inject
// `[pgService]` so dev only manages postgres in this tmpdir fixture.
const onlyPostgres = (): Service[] => [pgService];

/**
 * Recording compose runner factory — see dev.test.ts for the same helper.
 * Duplicated here to keep each test file self-contained and avoid coupling
 * unit-test fixtures across files.
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

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stop-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stop-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  // Reserve the low end of the lich port range so this file's dev()
  // call allocates a port that does not race with dev.test.ts (which also
  // starts a postgres container from port 54000 in a sibling worker).
  await registry.upsert('aaaaaaaaaaaa', {
    path: '/tmp/lz-stop-reserved',
    branch: 'reserved',
    ports: { postgres: 54000, _1: 54001, _2: 54002 },
    urls: {},
    containers: [],
    network: 'lich-aaaaaaaaaaaa',
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
  });
});

function cleanup(key: string) {
  spawnSync('docker', ['rm', '-f', containerName(key, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(key, 'postgres')], { stdio: 'ignore' });
  // LEV-202 — prefer `compose down --remove-orphans` so ANY network the
  // project created is freed in one call. Falls through to a name-based rm
  // for the legacy `<project>_default` naming.
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

describe('lich stop (unit, mocked compose)', () => {
  it('errors NO_PROJECT when cwd is outside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stop-outside-')));
    const { factory } = makeMockComposeFactory();
    const cmd = makeStopCommand(() => registry, { composeRunnerFactory: factory });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a lich project/i);
  });

  it('returns stopped:false when no entry exists, without invoking compose runner', async () => {
    const { factory, constructed, calls } = makeMockComposeFactory();
    const cmd = makeStopCommand(() => registry, { composeRunnerFactory: factory });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    expect(result.stopped).toBe(false);
    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    // No registry entry → no runner instantiated, no down() called.
    expect(constructed).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('signals pid files in .lich/state/<key>/pids/ and removes them (LEV-194)', async () => {
    // Manually plant a registry entry + a pid file pointing at a real
    // sleeping child. Verifies the SIGTERM -> wait -> SIGKILL escalation
    // path and the cleanup of the pid file.
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

    const pidDir = join(projectDir, '.lich', 'state', wtKey, 'pids');
    mkdirSync(pidDir, { recursive: true });

    // A long-running child that ignores nothing; SIGTERM will kill it
    // because `sh -c sleep 30` doesn't install a trap. `detached: true`
    // mirrors what the real detached runner does.
    const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    writeFileSync(join(pidDir, 'longsleep.pid'), `${child.pid}\n`);

    // Also drop a malformed pid file to exercise the "skip+cleanup" branch.
    writeFileSync(join(pidDir, 'garbage.pid'), 'not-a-pid\n');

    const { factory } = makeMockComposeFactory();
    const stop = makeStopCommand(() => registry, {
      getServices: () => [],
      composeRunnerFactory: factory,
    });
    const result = (await stop.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.stopped).toBe(true);
    // Pid file was processed and removed.
    expect(existsSync(join(pidDir, 'longsleep.pid'))).toBe(false);
    // Garbage file was deleted defensively.
    expect(existsSync(join(pidDir, 'garbage.pid'))).toBe(false);

    // The owned-teardown summary includes the killed pid.
    const longsleepResult = result.owned.find((o: any) => o.name === 'longsleep');
    expect(longsleepResult).toBeDefined();
    expect(['terminated', 'killed']).toContain(longsleepResult.result);
    expect(longsleepResult.pid).toBe(child.pid);

    // The child should be dead now.
    let alive = true;
    try {
      process.kill(child.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('stop is a no-op for pid files when the dir does not exist', async () => {
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

    const { factory } = makeMockComposeFactory();
    const stop = makeStopCommand(() => registry, {
      getServices: () => [],
      composeRunnerFactory: factory,
    });
    const result = (await stop.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.stopped).toBe(true);
    expect(result.owned).toEqual([]);
  });

  it('after dev, stop calls compose down (volumes:false) and clears the entry', async () => {
    const { factory: devFactory } = makeMockComposeFactory();
    const dev = makeDevCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: devFactory,
    });
    const devResult = (await dev.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    const { factory, constructed, calls } = makeMockComposeFactory();
    const stop = makeStopCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const result = (await stop.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.stopped).toBe(true);
    expect(result.key).toBe(devResult.key);
    expect(result.containers).toEqual(devResult.containers);

    // Runner was constructed with the same project name as dev used.
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.projectName).toBe(composeProjectName(devResult.key));

    const downs = calls.filter((c) => c.op === 'down');
    expect(downs).toHaveLength(1);
    expect(downs[0]!.args[0]).toEqual({ volumes: false });

    expect(await registry.get(devResult.key)).toBeUndefined();
  });
});

describeIfDocker('lich stop (integration with real docker compose)', () => {
  it('after dev, stop removes containers, clears registry entry, leaves volume intact', async () => {
    // LEV-202 — withDockerStack ensures the compose stack is torn down even
    // if the assertions throw mid-test, before `afterEach`'s cleanup runs.
    const wtKey = computeWorktreeKey(projectDir);
    await withDockerStack({ projectName: composeProjectName(wtKey) }, async () => {
      const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
      const devResult = (await dev.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      })) as any;

      const stop = makeStopCommand(() => registry, { getServices: onlyPostgres });
      const result = (await stop.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      })) as any;
      expect(result.stopped).toBe(true);
      expect(result.key).toBe(devResult.key);
      expect(result.containers).toEqual(devResult.containers);

      expect(isContainerRunning(devResult.containers[0])).toBe(false);
      expect(await registry.get(devResult.key)).toBeUndefined();
      const r = spawnSync(
        'docker',
        ['volume', 'inspect', volumeName(devResult.key, 'postgres')],
        { stdio: 'pipe' },
      );
      expect(r.status).toBe(0);
    });
  }, 180_000);
});
