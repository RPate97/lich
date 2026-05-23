import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * LEV-210 — e2e for `@lich/create-stack-v0` itself.
 *
 * The dogfood suite (LEV-198) used to spawn this binary as its scaffold
 * step, but the LEV-198-extended agent bypassed it (uses copyTemplate
 * directly) to avoid cross-worktree template contamination — `bin.ts`
 * imports `@lich/template-v0-stack` via node_modules, and in a
 * multi-worktree dev setup that symlink chains up to a SIBLING worktree's
 * template tree, which can diverge from THIS worktree's plugin set. The
 * upshot: the user-facing scaffolder binary lost end-to-end coverage.
 *
 * Strategy: spawn the binary with `--template-from` pinned to THIS
 * worktree's `packages/template-v0-stack/files` directory so the bin's
 * own node_modules resolution is overridden. Production users never need
 * the flag; without it, the bundled template is used as before.
 *
 * Why this lives alongside `bin.test.ts`: the existing file is named
 * `bin.test.ts` and is conceptually a unit-level suite for argv parsing
 * + the scaffolded shape. This file is the e2e tier — exercises the full
 * spawn → template-copy → next-steps flow with a deterministic template
 * pin so it's resilient to whatever sibling worktrees happen to have on
 * disk at test time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'src', 'bin.ts');
const TEMPLATE_DIR = resolve(HERE, '..', '..', 'template-v0-stack', 'files');

let tmp: string;

function runBin(
  name: string,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    'bun',
    [BIN, name, '--template-from', TEMPLATE_DIR],
    { cwd, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('LEV-210 create-stack-v0 scaffold e2e', () => {
  beforeAll(() => {
    // realpathSync resolves macOS /var → /private/var so any path-equality
    // assertions are robust to symlink expansion. mkdtempSync inside the OS
    // tmpdir keeps the scaffold OUTSIDE the monorepo tree so bun's resolver
    // doesn't walk up to workspace symlinks (the same gotcha LEV-198 fixed
    // in the dogfood harness).
    tmp = realpathSync(mkdtempSync(join(osTmpdir(), 'lz-e2e-scaffold-')));
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — a leaked tmpdir under $TMPDIR is harmless.
    }
  });

  it('scaffolds a project tree with the canonical v0 template files', () => {
    const projectName = 'lev210-probe';
    const r = runBin(projectName, tmp);
    expect(r.status, r.stderr).toBe(0);

    const projectDir = join(tmp, projectName);
    // Root-level files the template always emits.
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'lich.config.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'turbo.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
    // App workspaces.
    expect(existsSync(join(projectDir, 'apps/api/package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'apps/web/package.json'))).toBe(true);
    // Prisma 7 split (LEV-121): schema + separate prisma.config.ts.
    expect(existsSync(join(projectDir, 'prisma/schema.prisma'))).toBe(true);
    expect(existsSync(join(projectDir, 'prisma.config.ts'))).toBe(true);
    // LEV-196 auth additions — assert because LEV-210's whole reason for
    // existing is to catch regressions in the user-facing scaffolder.
    expect(existsSync(join(projectDir, 'apps/api/src/auth.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'apps/web/src/app/sign-in/page.tsx'))).toBe(true);
    expect(existsSync(join(projectDir, 'apps/web/src/app/dashboard/page.tsx'))).toBe(true);
    expect(existsSync(join(projectDir, 'e2e/auth-flow.spec.ts'))).toBe(true);
  });

  it('substitutes the project name into package.json and lich.config.ts', () => {
    const projectName = 'lev210-substitution-probe';
    const r = runBin(projectName, tmp);
    expect(r.status, r.stderr).toBe(0);

    const projectDir = join(tmp, projectName);
    const pkg = readFileSync(join(projectDir, 'package.json'), 'utf8');
    expect(pkg).toContain(`"name": "${projectName}"`);
    const cfg = readFileSync(join(projectDir, 'lich.config.ts'), 'utf8');
    expect(cfg).toContain(`name: '${projectName}'`);
  });

  // LEV-216 regression guard at the e2e tier. The unit-level test in
  // `bin.test.ts` covers the same assertion against `runBin`'s captured
  // stdout, but having the check fire here too protects against the
  // case where the unit test's stdout capture drifts from what users
  // actually see when invoking `bunx @lich/create-stack-v0`.
  it("next-steps message recommends 'bun run lich dev' (LEV-216)", () => {
    const projectName = 'lev210-output-probe';
    const r = runBin(projectName, tmp);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('bun run lich dev');
    // The bare `bun run dev` (without the `lich` token) must not be
    // recommended as its own next-step line — that's the exact UX bug
    // LEV-216 closed and we don't want it sneaking back in.
    const lines = r.stdout.split('\n');
    const bareRunDevLines = lines.filter((l) => /^\s*bun run dev\s*$/.test(l));
    expect(bareRunDevLines.length).toBe(0);
  });

  // `--template-from` is the load-bearing wedge for this whole file. If it
  // ever silently stops being honored, every other test here would still
  // pass against whatever node_modules-resolved template happens to be on
  // disk. This test pins it down: pointing `--template-from` at an empty
  // throwaway directory must produce an empty scaffold (no canonical
  // files), proving the override is actually taking effect.
  it('--template-from override is honored (no fallback to node_modules template)', () => {
    const emptyTemplate = mkdtempSync(join(osTmpdir(), 'lz-empty-template-'));
    try {
      const projectName = 'lev210-override-probe';
      const r = spawnSync(
        'bun',
        [BIN, projectName, '--template-from', emptyTemplate],
        { cwd: tmp, encoding: 'utf8', timeout: 30_000 },
      );
      expect(r.status, r.stderr).toBe(0);
      const projectDir = join(tmp, projectName);
      // Directory should exist (copyTemplate creates `to` even if empty)
      // but none of the canonical template files should be there.
      expect(existsSync(projectDir)).toBe(true);
      expect(existsSync(join(projectDir, 'package.json'))).toBe(false);
      expect(existsSync(join(projectDir, 'lich.config.ts'))).toBe(false);
    } finally {
      try {
        rmSync(emptyTemplate, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  });
});
