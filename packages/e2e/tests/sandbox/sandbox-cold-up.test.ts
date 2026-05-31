import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTartAvailable } from '../../helpers/tart.js';

const LICH = process.env.LICH ?? `${process.cwd()}/../lich/dist/lich`;

function imageExists(): boolean {
  try {
    const out = execSync('tart list --format json', { encoding: 'utf8' });
    return JSON.parse(out).some((e: any) => e.Name === 'lich-sandbox-base');
  } catch {
    return false;
  }
}

describe.skipIf(!isTartAvailable() || !imageExists())('sandbox cold-up (e2e)', () => {
  let workTmp: string;

  beforeAll(() => {
    workTmp = mkdtempSync(join(tmpdir(), 'lich-cold-up-'));
    cpSync(join(__dirname, '../../fixtures/dogfood-stack'), join(workTmp, 'stack'), { recursive: true });
    execSync('bash scripts/generate-heavy-migrations.sh', {
      cwd: join(workTmp, 'stack'),
      stdio: 'inherit',
    });
    // Append runtime.sandbox to the lich.yaml.
    const yamlPath = join(workTmp, 'stack', 'lich.yaml');
    const yaml = readFileSync(yamlPath, 'utf8');
    writeFileSync(yamlPath, yaml + `\nruntime:\n  sandbox:\n    backend: tart\n    image: lich-sandbox-base\n    warm_fork: false\n`);
  });

  afterAll(() => {
    try { execSync(`${LICH} down dev:heavy`, { cwd: join(workTmp, 'stack'), stdio: 'inherit' }); } catch {}
    try { execSync(`tart delete lich-run-$(echo -n ${workTmp} | shasum -a 256 | cut -c1-16)-dev-heavy`); } catch {}
  });

  test('lich up dev:heavy cold-boots inside a sandbox VM', () => {
    const out = execSync(`${LICH} up dev:heavy`, {
      cwd: join(workTmp, 'stack'),
      encoding: 'utf8',
      timeout: 600_000,
    });
    expect(out).toContain('cold-booted');
    // Verify the VM exists with lich-run prefix.
    const tartList = execSync('tart list --format json', { encoding: 'utf8' });
    const entries = JSON.parse(tartList);
    expect(entries.some((e: any) => e.Name.startsWith('lich-run-') && e.Name.endsWith('-dev-heavy'))).toBe(true);
  }, 600_000);
});
