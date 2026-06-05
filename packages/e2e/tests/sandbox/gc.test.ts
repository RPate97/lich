import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTartAvailable, imageExists } from '../../helpers/tart.js';

const LICH = process.env.LICH ?? `${process.cwd()}/../lich/dist/lich`;
const FIXTURE = join(__dirname, '../../fixtures/dogfood-stack');
const PROFILE = 'dev:heavy';

// Each worktree gets a unique divergent migration → distinct bake_inputs hash
// → distinct golden for the same profile. After the third snapshot, runGc
// (post-bake per Task 7) should keep only `keep_per_profile` (default 2)
// goldens for the profile.
function prepareWorktree(name: string, divergentMigration: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lich-${name}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  execSync('bash scripts/generate-heavy-migrations.sh', { cwd: dir, stdio: 'inherit' });
  const yamlPath = join(dir, 'lich.yaml');
  const yaml = readFileSync(yamlPath, 'utf8');
  if (!/^runtime:\s*$/m.test(yaml)) {
    throw new Error('dogfood-stack/lich.yaml no longer has a top-level `runtime:` key; update injection logic');
  }
  const injected = yaml.replace(
    /^runtime:\s*$/m,
    'runtime:\n  sandbox:\n    backend: tart\n    image: lich-sandbox-base\n    memory: 6144\n    bake_inputs: ["db/migrations/**", "db/migrations-heavy/**", "db/seed-heavy.sql"]',
  );
  writeFileSync(yamlPath, injected);
  writeFileSync(join(dir, 'db/migrations/999_divergent.sql'), divergentMigration);
  return dir;
}

function runLich(args: string, cwd: string, lichHome: string, timeout: number, opts: { capture?: boolean } = {}): string {
  return execSync(`${LICH} ${args}`, {
    cwd,
    env: { ...process.env, LICH_HOME: lichHome },
    encoding: 'utf8',
    timeout,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  }) as unknown as string;
}

describe.skipIf(!isTartAvailable() || !imageExists())('sandbox GC (e2e)', () => {
  let wt1: string;
  let wt2: string;
  let wt3: string;
  let lichHome: string;

  beforeAll(() => {
    lichHome = mkdtempSync(join(tmpdir(), 'lich-gc-home-'));
    wt1 = prepareWorktree('gc-wt1', '-- variant 1\n');
    wt2 = prepareWorktree('gc-wt2', '-- variant 2\n');
    wt3 = prepareWorktree('gc-wt3', '-- variant 3\n');
  }, 300_000);

  afterAll(() => {
    for (const wt of [wt1, wt2, wt3]) {
      try { execSync(`${LICH} down ${PROFILE} --purge`, { cwd: wt, env: { ...process.env, LICH_HOME: lichHome }, stdio: 'ignore', timeout: 120_000 }); } catch { /* best-effort */ }
    }
    try { execSync(`${LICH} nuke --yes`, { cwd: wt1, env: { ...process.env, LICH_HOME: lichHome }, stdio: 'ignore', timeout: 120_000 }); } catch { /* best-effort */ }
    for (const wt of [wt1, wt2, wt3, lichHome]) {
      try { rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 600_000);

  test('baking a 3rd golden for a profile evicts the oldest', () => {
    // Each worktree: up → down --purge (warm_fork default → bake-on-down).
    for (const wt of [wt1, wt2, wt3]) {
      runLich(`up ${PROFILE}`, wt, lichHome, 900_000);
      runLich(`down ${PROFILE} --purge`, wt, lichHome, 300_000);
    }

    const statusOut = runLich('sandbox status --json', wt3, lichHome, 60_000, { capture: true });
    const status = JSON.parse(statusOut) as { goldens: Array<{ profileName: string; createdAt: string }>; policy: { keepPerProfile: number } };
    const profileGoldens = status.goldens.filter((g) => g.profileName === PROFILE);
    expect(profileGoldens.length).toBe(status.policy.keepPerProfile);
    expect(profileGoldens.length).toBe(2);
  }, 1_800_000);
});
