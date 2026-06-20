import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyFixtureToTmpdir } from '../../helpers/tmpdir.js';
import { runLich } from '../../helpers/lich.js';
import { sweepStaleLichResources } from '../../helpers/heavy-pool-cleanup.js';

describe('dev:heavy profile boots end-to-end (host, no sandbox)', () => {
  let stackPath: string;
  let cleanup: () => void;
  let lichHome: string;

  beforeAll(() => {
    // Clear any docker compose containers a previous heavy test left half-down
    // (port 5432 / container-name conflicts cause an 8s `lich up` exit-1 flake).
    sweepStaleLichResources();
    const stack = copyFixtureToTmpdir('dogfood-stack', { install: true });
    stackPath = stack.path;
    cleanup = stack.cleanup;
    lichHome = mkdtempSync(join(tmpdir(), 'lich-e2e-dev-heavy-home-'));
    execSync('bash scripts/generate-heavy-migrations.sh', { cwd: stackPath, stdio: 'inherit' });
  });

  afterAll(async () => {
    try {
      runLich(['down'], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 30_000 });
    } catch { /* best-effort */ }
    try {
      runLich(['nuke', '--yes'], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 30_000 });
    } catch { /* best-effort */ }
    // Give docker compose a moment to actually release ports.
    sweepStaleLichResources();
    await new Promise((r) => setTimeout(r, 1_500));
    try { cleanup(); } catch { /* best-effort */ }
  });

  test('lich up dev:heavy completes and migrations land', () => {
    const upResult = runLich(['up', 'dev:heavy', '--no-browser'], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
      timeout: 300_000,
    });
    if (upResult.exitCode !== 0) {
      console.error('lich up stdout:', upResult.stdout);
      console.error('lich up stderr:', upResult.stderr);
    }
    expect(upResult.exitCode).toBe(0);

    const colCheck = runLich(
      ['exec', '--', 'sh', '-c', `psql "$DATABASE_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='things' AND column_name='col_0500'"`],
      { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 30_000 },
    );
    expect(colCheck.stdout.trim()).toBe('col_0500');

    const countCheck = runLich(
      ['exec', '--', 'sh', '-c', `psql "$DATABASE_URL" -tAc "SELECT count(*) FROM things"`],
      { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 30_000 },
    );
    expect(parseInt(countCheck.stdout.trim(), 10)).toBeGreaterThanOrEqual(50_000);
  }, 360_000);
});
