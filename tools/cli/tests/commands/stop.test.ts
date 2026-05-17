import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { makeStopCommand } from '../../src/commands/stop';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/docker/naming';
import { isContainerRunning } from '../../src/docker/runner';
import { pgService } from '../../src/services/postgres';
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
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  // Reserve the low end of the levelzero port range so this file's dev()
  // call allocates a port that does not race with dev.test.ts (which also
  // starts a postgres container from port 54000 in a sibling worker).
  await registry.upsert('aaaaaaaaaaaa', {
    path: '/tmp/lz-stop-reserved',
    branch: 'reserved',
    ports: { postgres: 54000, _1: 54001, _2: 54002 },
    urls: {},
    containers: [],
    network: 'levelzero-aaaaaaaaaaaa',
    logDir: '.levelzero/logs',
    createdAt: new Date().toISOString(),
  });
});

function cleanup(key: string) {
  spawnSync('docker', ['rm', '-f', containerName(key, 'postgres')], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', volumeName(key, 'postgres')], { stdio: 'ignore' });
  // Compose default network — `down` should clean it, but the unit tests use
  // a mock runner that doesn't actually run compose. Best-effort.
  spawnSync('docker', ['network', 'rm', `levelzero-${key}_default`], { stdio: 'ignore' });
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describe('levelzero stop (unit, mocked compose)', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stop-outside-')));
    const { factory } = makeMockComposeFactory();
    const cmd = makeStopCommand(() => registry, { composeRunnerFactory: factory });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
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
    expect(constructed[0]!.projectName).toBe(`levelzero-${devResult.key}`);

    const downs = calls.filter((c) => c.op === 'down');
    expect(downs).toHaveLength(1);
    expect(downs[0]!.args[0]).toEqual({ volumes: false });

    expect(await registry.get(devResult.key)).toBeUndefined();
  });
});

describeIfDocker('levelzero stop (integration with real docker compose)', () => {
  it('after dev, stop removes containers, clears registry entry, leaves volume intact', async () => {
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

    expect(await isContainerRunning(devResult.containers[0])).toBe(false);
    expect(await registry.get(devResult.key)).toBeUndefined();
    const r = spawnSync(
      'docker',
      ['volume', 'inspect', volumeName(devResult.key, 'postgres')],
      { stdio: 'pipe' },
    );
    expect(r.status).toBe(0);
  }, 180_000);
});
