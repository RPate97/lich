import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p08-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p08-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  writeFileSync(
    join(projectDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
      },
      include: ['src/**/*'],
    }),
  );
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  // target.ts is imported by dependent.ts
  writeFileSync(join(projectDir, 'src', 'target.ts'), 'export const T = 1;\n');
  writeFileSync(
    join(projectDir, 'src', 'dependent.ts'),
    "import { T } from './target';\nexport const D = T + 1;\n",
  );
  writeFileSync(join(projectDir, 'src', 'unrelated.ts'), 'export const U = 99;\n');
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-08 commands end-to-end', () => {
  // LEV-168 — pretty is the default; pass `--json` where the test parses stdout/stderr.
  it('impact <path> returns dependents as a JSON array', () => {
    const res = run(['impact', 'src/target.ts', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Array.isArray(out)).toBe(true);
    // dependent.ts imports target.ts; unrelated.ts does not.
    expect(out.some((p: string) => p.endsWith('src/dependent.ts'))).toBe(true);
    expect(out.some((p: string) => p.endsWith('src/unrelated.ts'))).toBe(false);
  }, 30_000);

  it('impact with no arg exits 1 with a CLIError JSON', () => {
    const res = run(['impact', '--json']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('check runs all registered rules and prints pass/skip/fail summary', () => {
    const res = run(['check', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.summary).toMatchObject({
      pass: expect.any(Number),
      fail: expect.any(Number),
      skip: expect.any(Number),
      total: expect.any(Number),
    });
    // builtin rules currently all skip; total should equal skip.
    expect(out.summary.fail).toBe(0);
    expect(out.summary.total).toBeGreaterThanOrEqual(1);
    expect(out.summary.skip).toBe(out.summary.total);
    expect(Array.isArray(out.results)).toBe(true);
  }, 30_000);

  it('coverage is a registered command (does not error as UNKNOWN_COMMAND)', () => {
    // We deliberately do not execute `coverage` end-to-end here: it would
    // spawn vitest inside a vitest run and recurse. Instead, assert the
    // command is registered by checking that an unrelated failure mode
    // (not UNKNOWN_COMMAND) surfaces if we invoke it with a bogus flag.
    const res = run(['coverage', '--threshold', 'not-a-number', '--json']);
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    // Must NOT be UNKNOWN_COMMAND — that would mean the command isn't wired.
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
    // Should be the threshold-parse error.
    expect(err.code).toBe('CONFIG_INVALID');
  }, 30_000);
});
