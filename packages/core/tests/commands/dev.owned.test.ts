import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip, withDockerStack } from '../_helpers/docker';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, composeProjectName, volumeName } from '../../src/compose/naming';
import { pgService } from '@levelzero/plugin-postgres';
import type { OwnedService, Service } from '../../src/services/types';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

let projectDir: string;
let homeDir: string;
let registry: Registry;

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-owned-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-dev-owned-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  await registry.upsert('dev-owned-reserved-base', {
    path: '/__dev_owned_reserved__',
    branch: '',
    ports: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`p${i}`, 54000 + i]),
    ),
    urls: {},
    containers: [],
    network: '',
    logDir: '',
    createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  if (projectDir) {
    const k = computeWorktreeKey(projectDir);
    spawnSync('docker', ['rm', '-f', containerName(k, 'postgres')], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', '-f', volumeName(k, 'postgres')], { stdio: 'ignore' });
    // LEV-202 — `compose down --remove-orphans` catches the project's
    // network too, so the host's address pool doesn't accumulate orphans.
    const projectName = composeProjectName(k);
    spawnSync(
      'docker',
      ['compose', '-p', projectName, 'down', '--volumes', '--remove-orphans', '--timeout', '5'],
      { stdio: 'ignore' },
    );
    spawnSync('docker', ['network', 'rm', `${projectName}_default`], { stdio: 'ignore' });
  }
});

describeIfDocker('dev with owned services (DI)', () => {
  it('starts postgres + a mock owned service, tees its logs, returns exit codes', async () => {
    // LEV-202 — withDockerStack guarantees compose teardown even if assertions
    // throw mid-test, so the project's network is freed before the next test.
    const wtKey = computeWorktreeKey(projectDir);
    await withDockerStack({ projectName: composeProjectName(wtKey) }, async () => {
      // LEV-187: pgService no longer publishes DATABASE_URL through the legacy
      // envContributions hook. The echoer publishes it itself (constructing
      // the URL the same way plugin-postgres' `addEnvSource('url')` does) so
      // its sh fixture can still read `$DATABASE_URL`. Once Plan 16 Tier 2
      // plumbs EnvSource resolution into the owned-runner this becomes
      // unnecessary.
      const echoSvc: OwnedService = {
        name: 'echoer',
        kind: 'owned',
        portNames: [],
        cwd: projectDir,
        command: 'sh -c "echo DATABASE_URL=$DATABASE_URL; echo done-echoer"',
        envContributions: (ports) => ({
          DATABASE_URL: `postgres://levelzero:levelzero@localhost:${ports.postgres}/levelzero`,
        }),
        dependsOn: ['postgres'],
      };
      const getServices = (): Service[] => [pgService, echoSvc];
      const dev = makeDevCommand(() => registry, { getServices });

      // LEV-194 — `--live` runs the concurrently foreground runner so exit
      // codes and JSONL logs are captured (the detached default returns
      // before child exits and writes raw `.log` files instead).
      const result = (await dev.run({ cwd: projectDir, format: 'json', args: [], flags: { live: true } })) as any;

      expect(result.ports.postgres).toBeGreaterThanOrEqual(54060);
      // DATABASE_URL is now contributed by the echoer service itself (see
      // comment above). Plan 16 Tier 2 will route EnvSources back into this slot.
      expect(result.env.DATABASE_URL).toContain(`localhost:${result.ports.postgres}`);
      expect(result.containers).toContain(containerName(result.key, 'postgres'));

      expect(result.owned).toBeDefined();
      expect(result.owned.exitCodes.echoer).toBe(0);

      const logPath = join(projectDir, '.levelzero', 'logs', 'echoer.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(lines.some((l: any) => l.message.includes('done-echoer'))).toBe(true);
      expect(lines.some((l: any) => l.message.includes(`DATABASE_URL=postgres://`))).toBe(true);
    });
  }, 180_000);

  it('without owned services, behavior is unchanged (returns immediately after docker up)', async () => {
    // LEV-202 — withDockerStack guarantees compose teardown even on assertion failure.
    const wtKey = computeWorktreeKey(projectDir);
    await withDockerStack({ projectName: composeProjectName(wtKey) }, async () => {
      // Inject `[pgService]` directly: the default builtins now include api+web
      // OwnedServices (LEV-90) which would try to spawn `bun run dev` in
      // missing `apps/api`/`apps/web` directories in this tmpdir fixture.
      const dev = makeDevCommand(() => registry, { getServices: (): Service[] => [pgService] });
      const start = Date.now();
      const result = (await dev.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(60_000);
      expect(result.owned).toBeUndefined();
      expect(result.ports.postgres).toBeGreaterThanOrEqual(54060);
    });
  }, 90_000);
});
