import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
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

describe('@lich/create-stack-v0 bin', () => {
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
    expect(existsSync(join(targetDir, 'lich.config.ts'))).toBe(true);
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'turbo.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'apps', 'web', 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'apps', 'api', 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'prisma', 'schema.prisma'))).toBe(true);
    // LEV-121: Prisma 7 split — the datasource URL lives in `prisma.config.ts`
    // at the project root (not on the `datasource` block in `schema.prisma`).
    expect(existsSync(join(targetDir, 'prisma.config.ts'))).toBe(true);

    // {{projectName}} substitution applied to package.json + lich.config.ts.
    const pkg = readFileSync(join(targetDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"name": "my-app"');
    const cfg = readFileSync(join(targetDir, 'lich.config.ts'), 'utf8');
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
    expect(r.stdout).toContain('npx @lich/create-stack-v0');
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

  // LEV-216: the canonical post-scaffold command is `bun run lich dev`
  // (not the bare `bun run dev`, which can fall through to a broken template
  // script). This is a forward-regression guard against re-introducing it.
  it('recommends `bun run lich dev` (not bare `bun run dev`) in next steps', () => {
    const r = runBin(['lev216-app'], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('bun run lich dev');
    // Defensive: the bare command must not appear as its own next-step line.
    expect(r.stdout).not.toMatch(/^ {2}bun run dev$/m);
  });

  // LEV-216 (defense in depth): scaffolding inside a monorepo workspace prints
  // an informational warning so users aren't blindsided by resolve issues.
  it('warns when scaffolding inside a monorepo workspace ancestor', () => {
    // Create a fake monorepo root that contains our scaffold target.
    const monorepoRoot = join(tmp, 'monorepo');
    mkdirSync(monorepoRoot, { recursive: true });
    writeFileSync(
      join(monorepoRoot, 'package.json'),
      JSON.stringify({ name: 'fake-monorepo', workspaces: ['packages/*'] }),
    );
    const r = runBin(['nested-app'], monorepoRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Heads up: this directory is inside a monorepo workspace');
    expect(r.stdout).toContain(monorepoRoot);
  });

  // The warning is informational only — outside a monorepo it must not fire.
  it('does NOT print the monorepo warning when scaffolding outside any monorepo', () => {
    const r = runBin(['clean-app'], tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Heads up: this directory is inside a monorepo workspace');
  });
});
