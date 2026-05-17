import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from './_helpers/docker';
import { computeWorktreeKey } from '../src/worktree';
import { containerName, volumeName } from '../src/docker/naming';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p02-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p02-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  // The default builtins (LEV-90) now include `api` and `web` OwnedServices
  // that spawn `bun run dev` in `apps/api`/`apps/web`. Provide trivial
  // package.json stubs whose `dev` script exits 0 so concurrently doesn't
  // crash the run on missing directories.
  for (const app of ['api', 'web']) {
    const dir = join(projectDir, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `e2e-${app}`, scripts: { dev: 'true' } }),
    );
  }
});

afterEach(() => {
  if (projectDir) {
    const k = computeWorktreeKey(projectDir);
    spawnSync('docker', ['rm', '-f', containerName(k, 'postgres')], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', '-f', volumeName(k, 'postgres')], { stdio: 'ignore' });
  }
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LEVELZERO_HOME: homeDir },
    encoding: 'utf8',
  });
}

describeIfDocker('bin: plan-02 commands end-to-end', () => {
  it('dev brings up postgres; stacks current reports running; stop tears it down', () => {
    const dev = run(['dev']);
    expect(dev.status, dev.stderr).toBe(0);
    const devJson = JSON.parse(dev.stdout);
    expect(devJson.ports.postgres).toBeGreaterThanOrEqual(54000);
    expect(devJson.containers.length).toBeGreaterThanOrEqual(1);

    const cur = run(['stacks', 'current']);
    expect(cur.status).toBe(0);
    const curJson = JSON.parse(cur.stdout);
    expect(curJson.running).toBe(true);
    expect(curJson.entry.ports.postgres).toBe(devJson.ports.postgres);

    const psql = spawnSync('docker', [
      'exec', devJson.containers[0],
      'psql', '-U', 'levelzero', '-d', 'levelzero', '-c', 'select 42;',
    ], { encoding: 'utf8' });
    expect(psql.status).toBe(0);

    const stop = run(['stop']);
    expect(stop.status).toBe(0);
    const stopJson = JSON.parse(stop.stdout);
    expect(stopJson.stopped).toBe(true);

    const cur2 = run(['stacks', 'current']);
    expect(cur2.status).toBe(0);
    expect(JSON.parse(cur2.stdout).running).toBe(false);
  }, 180_000);

  it('stacks stop --all clears every running stack', () => {
    const dev = run(['dev']);
    expect(dev.status).toBe(0);

    const stopAll = run(['stacks', 'stop', '--all']);
    expect(stopAll.status).toBe(0);
    const out = JSON.parse(stopAll.stdout);
    expect(Array.isArray(out.stoppedFromRegistry)).toBe(true);
    expect(out.stoppedFromRegistry.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
