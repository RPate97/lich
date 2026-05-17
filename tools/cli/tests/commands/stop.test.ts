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
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describe('levelzero stop (unit)', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stop-outside-')));
    const cmd = makeStopCommand(() => registry);
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
  });

  it('returns stopped:false when no entry exists', async () => {
    const cmd = makeStopCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.stopped).toBe(false);
    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describeIfDocker('levelzero stop (integration with dev)', () => {
  it('after dev, stop removes containers, clears registry entry, leaves volume intact', async () => {
    const dev = makeDevCommand(() => registry);
    const devResult = (await dev.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;

    const stop = makeStopCommand(() => registry);
    const result = (await stop.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.stopped).toBe(true);
    expect(result.key).toBe(devResult.key);
    expect(result.containers).toEqual(devResult.containers);

    expect(await isContainerRunning(devResult.containers[0])).toBe(false);
    expect(await registry.get(devResult.key)).toBeUndefined();
    const r = spawnSync('docker', ['volume', 'inspect', volumeName(devResult.key, 'postgres')], { stdio: 'pipe' });
    expect(r.status).toBe(0);
  }, 120_000);
});
