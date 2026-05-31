import { describe, test, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LICH = process.env.LICH ?? `${process.cwd()}/../lich/dist/lich`;

function runValidate(yaml: string): { exitCode: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lich-config-'));
  writeFileSync(join(dir, 'lich.yaml'), yaml);
  try {
    execSync(`${LICH} validate`, { cwd: dir, stdio: 'pipe' });
    return { exitCode: 0, stderr: '' };
  } catch (err: any) {
    return { exitCode: err.status ?? -1, stderr: String(err.stderr ?? '') };
  }
}

describe('lich validate accepts runtime.sandbox', () => {
  test('valid sandbox block passes', () => {
    const r = runValidate(`
version: "1"
runtime:
  sandbox:
    backend: tart
    image: lich-sandbox-base
owned:
  api:
    cmd: echo hi
    cwd: .
profiles:
  default:
    default: true
    owned: [api]
`);
    expect(r.exitCode).toBe(0);
  });

  test('invalid backend fails', () => {
    const r = runValidate(`
version: "1"
runtime:
  sandbox:
    backend: hyperv
`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('sandbox');
  });
});
