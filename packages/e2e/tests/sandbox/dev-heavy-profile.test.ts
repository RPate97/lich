import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnLich, lichUp, lichDown } from '../../helpers/lich.js';
import { copyFixtureToTmp } from '../../helpers/tmpdir.js';
import { execSync } from 'node:child_process';

describe('dev:heavy profile boots end-to-end (host, no sandbox)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await copyFixtureToTmp('dogfood-stack');
    execSync(`bash scripts/generate-heavy-migrations.sh`, { cwd: tmpDir, stdio: 'inherit' });
  });

  afterAll(async () => {
    await lichDown(tmpDir);
  });

  test('lich up dev:heavy completes and migrations land', async () => {
    const result = await lichUp(tmpDir, { profile: 'dev:heavy', timeoutMs: 300_000 });
    expect(result.exitCode).toBe(0);

    const psql = spawnLich(tmpDir, ['exec', '--', 'bash', '-c',
      `psql "$DATABASE_URL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='things' AND column_name='col_0500'"`]);
    expect((await psql.stdoutPromise).trim()).toBe('col_0500');

    const count = spawnLich(tmpDir, ['exec', '--', 'bash', '-c',
      `psql "$DATABASE_URL" -tAc "SELECT count(*) FROM things"`]);
    expect(parseInt((await count.stdoutPromise).trim(), 10)).toBeGreaterThanOrEqual(50_000);
  }, 300_000);
});
