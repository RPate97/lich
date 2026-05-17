import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { makeResetCommand } from '../../src/commands/reset';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/docker/naming';
import { dockerExec } from '../../src/docker/exec';
import { pgService } from '../../src/services/postgres';
import type { Service } from '../../src/services/types';

// Default builtins include api+web OwnedServices (LEV-90) which would try
// to spawn `bun run dev` in missing `apps/api`/`apps/web` directories in
// this tmpdir fixture. Inject `[pgService]` to scope dev to postgres only.
const onlyPostgres = (): Service[] => [pgService];

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reset-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reset-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  // Pre-seed reserved ports 54000-54019 so this file's dev call lands at 54020+.
  // Avoids parallel-worker collisions with dev.test.ts (54000+) and stop.test.ts.
  await registry.upsert('reset-reserved-base', {
    path: '/__reset_reserved__',
    branch: '',
    ports: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`p${i}`, 54000 + i]),
    ),
    urls: {},
    containers: [],
    network: '',
    logDir: '',
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

describe('levelzero reset (unit)', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reset-outside-')));
    const cmd = makeResetCommand(() => registry);
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
  });
});

describeIfDocker('levelzero reset (integration)', () => {
  it('after dev, reset wipes the volume and brings up an empty DB', async () => {
    const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
    const devResult = (await dev.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    const cname = devResult.containers[0];

    const insert = await dockerExec([
      'exec', cname, 'psql', '-U', 'levelzero', '-d', 'levelzero',
      '-c', 'create table marker(x int); insert into marker values (1);',
    ], { timeoutMs: 10_000 });
    expect(insert.exitCode).toBe(0);

    const reset = makeResetCommand(() => registry, { getServices: onlyPostgres });
    const result = (await reset.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;

    expect(result.key).toBe(devResult.key);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54020);
    expect(result.env.DATABASE_URL).toContain(`localhost:${result.ports.postgres}`);

    const select = await dockerExec([
      'exec', result.containers[0], 'psql', '-U', 'levelzero', '-d', 'levelzero',
      '-c', 'select 1 from marker;',
    ], { timeoutMs: 10_000 });
    expect(select.exitCode).not.toBe(0);
    expect(select.stderr).toMatch(/relation .*marker.* does not exist/i);
  }, 240_000);

  it('reset works when no entry exists (cleans orphan volumes, then brings up)', async () => {
    const cmd = makeResetCommand(() => registry, { getServices: onlyPostgres });
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54020);
  }, 180_000);
});
