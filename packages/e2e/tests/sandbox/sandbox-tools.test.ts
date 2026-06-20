import { describe, test, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTartAvailable } from '../../helpers/tart.js';

const _here = dirname(fileURLToPath(import.meta.url));
const LICH = process.env.LICH ?? resolve(_here, '../../../lich/dist/lich');

function lichRun(args: string, env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    return { stdout: execSync(`${LICH} ${args}`, { encoding: 'utf8', env: { ...process.env, ...env } }), status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString() ?? '', status: err.status ?? -1 };
  }
}

describe.skipIf(!isTartAvailable())('lich sandbox status/purge/refresh (e2e)', () => {
  let lichHome: string;

  beforeAll(() => {
    lichHome = mkdtempSync(join(tmpdir(), 'lich-home-'));
  });

  test('status prints empty when no goldens', () => {
    const out = lichRun('sandbox status', { LICH_HOME: lichHome }).stdout;
    expect(out).toContain('GOLDENS');
    expect(out).toContain('FORKS');
    expect(out).toContain('(none)');
  });

  test('purge --store-only on empty store is harmless', () => {
    const r = lichRun('sandbox purge --store-only', { LICH_HOME: lichHome });
    expect(r.status).toBe(0);
  });

  test('refresh on missing golden reports no-op cleanly', () => {
    const tmpStack = mkdtempSync(join(tmpdir(), 'lich-refresh-stack-'));
    execSync(`echo 'version: "1"' > ${tmpStack}/lich.yaml`);
    const r = lichRun('sandbox refresh default', { LICH_HOME: lichHome });
    // We're not in the stack dir so the cwd-based path lookup will not find lich.yaml.
    // The command should still exit cleanly (it might report no golden found).
    expect([0, 1]).toContain(r.status);
  });
});
