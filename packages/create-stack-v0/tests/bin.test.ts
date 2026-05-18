import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'src', 'bin.ts');

function runBin(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [BIN, ...args], { cwd, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-create-')));
});

describe('@levelzero/create-stack-v0 bin', () => {
  it('scaffolds the v0 template into ./<name>/ and prints next steps', () => {
    const r = runBin(['my-app'], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Scaffolded my-app');
    expect(r.stdout).toContain('Next steps:');
    expect(r.stdout).toContain('cd my-app');
    expect(r.stdout).toContain('bun install');

    const targetDir = join(tmp, 'my-app');
    // Canonical files from the v0 template should land at the destination.
    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'levelzero.config.ts'))).toBe(true);
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'turbo.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'apps', 'web', 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'apps', 'api', 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'prisma', 'schema.prisma'))).toBe(true);

    // {{projectName}} substitution applied to package.json + levelzero.config.ts.
    const pkg = readFileSync(join(targetDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"name": "my-app"');
    const cfg = readFileSync(join(targetDir, 'levelzero.config.ts'), 'utf8');
    expect(cfg).toContain("name: 'my-app'");
  });

  it('accepts an absolute path and scaffolds there directly', () => {
    const target = join(tmp, 'absolute-app');
    const r = runBin([target], tmp);
    expect(r.status).toBe(0);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  it('prints help and exits 1 when no args are given', () => {
    const r = runBin([], tmp);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('npx @levelzero/create-stack-v0');
  });

  it('prints help and exits 0 on --help', () => {
    const r = runBin(['--help'], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('prints help and exits 0 on -h', () => {
    const r = runBin(['-h'], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('rejects invalid project names with a clear error', () => {
    const r = runBin(['has spaces'], tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid project name');
  });

  it('rejects names that start with a digit or symbol', () => {
    const r = runBin(['1bad'], tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid project name');
  });
});
