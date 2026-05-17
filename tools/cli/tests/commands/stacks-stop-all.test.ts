import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { makeStacksStopAllCommand } from '../../src/commands/stacks/stop-all';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/docker/naming';
import { isContainerRunning } from '../../src/docker/runner';
import { CLIError } from '../../src/errors';
import { pgService } from '../../src/services/postgres';
import type { Service } from '../../src/services/types';

// Default builtins now include api+web OwnedServices (LEV-90). Inject
// `[pgService]` so dev only manages postgres in these tmpdir fixtures.
const onlyPostgres = (): Service[] => [pgService];

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

let homeDir: string;
let registry: Registry;
let createdProjectDirs: string[] = [];

beforeEach(async () => {
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stopall-home-')));
  registry = new Registry(join(homeDir, 'registry.json'));
  // Pre-seed reserved ports 54000-54039 so this file's dev calls land at 54040+.
  await registry.upsert('stopall-reserved-base', {
    path: '/__stopall_reserved__',
    branch: '',
    ports: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`p${i}`, 54000 + i]),
    ),
    urls: {},
    containers: [],
    network: '',
    logDir: '',
    createdAt: new Date().toISOString(),
  });
  createdProjectDirs = [];
});

function makeProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-stopall-proj-')));
  writeFileSync(join(dir, 'levelzero.config.ts'), 'export default {};');
  createdProjectDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of createdProjectDirs) {
    const k = computeWorktreeKey(d);
    spawnSync('docker', ['rm', '-f', containerName(k, 'postgres')], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', '-f', volumeName(k, 'postgres')], { stdio: 'ignore' });
  }
});

describe('levelzero stacks stop --all (unit)', () => {
  it('errors without --all flag', async () => {
    const cmd = makeStacksStopAllCommand(() => registry);
    await expect(
      cmd.run({ cwd: '/', format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('returns empty results when nothing is running and no orphans exist', async () => {
    const cmd = makeStacksStopAllCommand(() => registry);
    const result = (await cmd.run({ cwd: '/', format: 'json', args: [], flags: { all: true } })) as any;
    expect(Array.isArray(result.stoppedFromRegistry)).toBe(true);
    expect(Array.isArray(result.stoppedOrphans)).toBe(true);
    expect(result.stoppedOrphans).toEqual([]);
  });
});

describeIfDocker('levelzero stacks stop --all (integration)', () => {
  it('tears down stacks from two different worktrees', async () => {
    const dirA = makeProject();
    const dirB = makeProject();
    const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
    const a = (await dev.run({ cwd: dirA, format: 'json', args: [], flags: {} })) as any;
    const b = (await dev.run({ cwd: dirB, format: 'json', args: [], flags: {} })) as any;

    expect(await isContainerRunning(a.containers[0])).toBe(true);
    expect(await isContainerRunning(b.containers[0])).toBe(true);

    const cmd = makeStacksStopAllCommand(() => registry);
    const result = (await cmd.run({ cwd: '/', format: 'json', args: [], flags: { all: true } })) as any;

    expect(result.stoppedFromRegistry).toContain(a.key);
    expect(result.stoppedFromRegistry).toContain(b.key);
    expect(await isContainerRunning(a.containers[0])).toBe(false);
    expect(await isContainerRunning(b.containers[0])).toBe(false);
    expect(await registry.get(a.key)).toBeUndefined();
    expect(await registry.get(b.key)).toBeUndefined();
  }, 240_000);
});
