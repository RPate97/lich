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
import { containerName, volumeName } from '../../src/compose/naming';
import { pgService } from '@levelzero/plugin-postgres';
import type { Service } from '../../src/services/types';
import type { ComposeRunner } from '../../src/compose/runner';

// Default builtins include api+web OwnedServices (LEV-90) which would try
// to spawn `bun run dev` in missing `apps/api`/`apps/web` directories in
// this tmpdir fixture. Inject `[pgService]` to scope dev to postgres only.
const onlyPostgres = (): Service[] => [pgService];

/**
 * Recording compose runner factory — same shape as in dev.test.ts.
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
  // Compose default network — best-effort removal so repeated runs don't
  // exhaust docker's address pools.
  spawnSync('docker', ['network', 'rm', `levelzero-${key}_default`], { stdio: 'ignore' });
}

afterEach(() => {
  if (projectDir) cleanup(computeWorktreeKey(projectDir));
});

describe('levelzero reset (unit, mocked compose)', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-reset-outside-')));
    const { factory } = makeMockComposeFactory();
    const cmd = makeResetCommand(() => registry, { composeRunnerFactory: factory });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/not inside a levelzero project/i);
  });

  it('calls down({volumes:true}) then up via dev — full cycle', async () => {
    const { factory, calls } = makeMockComposeFactory();
    const cmd = makeResetCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    const ops = calls.map((c) => c.op);
    // reset → down -v, then dev → up
    expect(ops).toEqual(['down', 'up']);
    expect(calls[0]!.args[0]).toEqual({ volumes: true });
    expect(calls[1]!.args[0]).toEqual({ detach: true, waitForHealthy: true });

    expect(result.key).toMatch(/^[0-9a-f]{12}$/);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54020);
    expect(result.env.DATABASE_URL).toContain(`localhost:${result.ports.postgres}`);
  });

  it('after dev, reset still tears down with the same project name', async () => {
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
    const reset = makeResetCommand(() => registry, {
      getServices: onlyPostgres,
      composeRunnerFactory: factory,
    });
    const result = (await reset.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    // Same project name across reset's down and dev's subsequent up.
    expect(constructed.every((c) => c.projectName === `levelzero-${devResult.key}`)).toBe(
      true,
    );
    const ops = calls.map((c) => c.op);
    expect(ops).toEqual(['down', 'up']);
    expect(result.key).toBe(devResult.key);
  });
});

describeIfDocker('levelzero reset (integration with real docker compose)', () => {
  it('after dev, reset wipes the volume and brings up an empty DB', async () => {
    const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
    const devResult = (await dev.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;
    const cname = devResult.containers[0];

    const insert = spawnSync(
      'docker',
      [
        'exec', cname, 'psql', '-U', 'levelzero', '-d', 'levelzero',
        '-c', 'create table marker(x int); insert into marker values (1);',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(insert.status).toBe(0);

    const reset = makeResetCommand(() => registry, { getServices: onlyPostgres });
    const result = (await reset.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as any;

    expect(result.key).toBe(devResult.key);
    expect(result.ports.postgres).toBeGreaterThanOrEqual(54020);
    expect(result.env.DATABASE_URL).toContain(`localhost:${result.ports.postgres}`);

    const select = spawnSync(
      'docker',
      [
        'exec', result.containers[0], 'psql', '-U', 'levelzero', '-d', 'levelzero',
        '-c', 'select 1 from marker;',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(select.status).not.toBe(0);
    expect(select.stderr).toMatch(/relation .*marker.* does not exist/i);
  }, 300_000);
});
