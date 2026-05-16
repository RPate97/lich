import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/docker/naming';

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
