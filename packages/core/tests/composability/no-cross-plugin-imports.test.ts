import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeSource, formatViolations, type Violation } from './analyzer';

/**
 * Static check enforcing the composability rule (LEV-175): no plugin source
 * file may import from another `@levelzero/plugin-*` package or from
 * `@levelzero/template-*`. See docs/EXTENSION.md "Composability rule".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/composability -> tests -> core -> packages -> repo root
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** Recursively collect source files under a directory. */
function collectSources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir) as string[];
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
      collectSources(full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx === -1) continue;
    const ext = name.slice(dotIdx);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    // Skip .d.ts (type declarations are erased; reduces noise).
    if (name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Read a plugin package's `name` field. Returns null if the dir isn't one. */
function readPluginPackageName(pluginDir: string): string | null {
  const pkgPath = join(pluginDir, 'package.json');
  try {
    const stat = statSync(pkgPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

describe('plugin packages must not import from sibling @levelzero/plugin-* or @levelzero/template-*', () => {
  it('every packages/plugin-*/src/** file passes the composability check', () => {
    let pluginDirs: string[] = [];
    try {
      const names = readdirSync(PACKAGES_DIR) as string[];
      pluginDirs = names
        .filter((name) => name.startsWith('plugin-'))
        .map((name) => join(PACKAGES_DIR, name))
        .filter((full) => {
          try {
            return statSync(full).isDirectory();
          } catch {
            return false;
          }
        });
    } catch (err) {
      throw new Error(`Could not enumerate ${PACKAGES_DIR}: ${(err as Error).message}`);
    }

    // Sanity: in this repo we always have at least a couple plugin packages.
    // If this drops to zero something is structurally wrong with the test.
    expect(pluginDirs.length, 'no packages/plugin-* directories found').toBeGreaterThan(0);

    const allViolations: Violation[] = [];
    let totalFiles = 0;

    for (const pluginDir of pluginDirs) {
      const ownName = readPluginPackageName(pluginDir);
      if (!ownName) continue; // skip dirs without a package.json
      const srcDir = join(pluginDir, 'src');
      const files = collectSources(srcDir);
      totalFiles += files.length;
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        const rel = relative(REPO_ROOT, file);
        const violations = analyzeSource(rel, ownName, source);
        allViolations.push(...violations);
      }
    }

    if (allViolations.length > 0) {
      throw new Error('\n' + formatViolations(allViolations));
    }

    // Should have scanned a non-trivial number of files (sanity check that
    // the glob didn't silently return nothing).
    expect(totalFiles, 'no plugin source files scanned').toBeGreaterThan(0);
  });
});

describe('analyzer self-tests', () => {
  it('flags a cross-plugin import statement', () => {
    const source = [
      `import { pgService } from '@levelzero/plugin-postgres';`,
      `import { ok } from '@levelzero/core';`,
      `export const x = pgService;`,
    ].join('\n');
    const violations = analyzeSource('packages/plugin-foo/src/index.ts', '@levelzero/plugin-foo', source);
    expect(violations).toHaveLength(1);
    const v = violations[0]!;
    expect(v.specifier).toBe('@levelzero/plugin-postgres');
    expect(v.line).toBe(1);
    expect(v.reason).toMatch(/cross-plugin import/);
  });

  it('flags a cross-plugin import on a subpath', () => {
    const source = `import { foo } from '@levelzero/plugin-postgres/internals';`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe('@levelzero/plugin-postgres/internals');
  });

  it('flags dynamic import() of a sibling plugin', () => {
    const source = `const m = await import('@levelzero/plugin-redis');`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe('@levelzero/plugin-redis');
  });

  it('flags require() of a sibling plugin', () => {
    const source = `const m = require('@levelzero/plugin-hono');`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe('@levelzero/plugin-hono');
  });

  it('flags re-export from a sibling plugin', () => {
    const source = `export { x } from '@levelzero/plugin-prisma';`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe('@levelzero/plugin-prisma');
  });

  it('flags imports from @levelzero/template-*', () => {
    const source = `import { x } from '@levelzero/template-v0-stack';`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toHaveLength(1);
    const v = violations[0]!;
    expect(v.specifier).toBe('@levelzero/template-v0-stack');
    expect(v.reason).toMatch(/template import/);
  });

  it('allows imports from @levelzero/core (and subpaths)', () => {
    const source = [
      `import { Plugin } from '@levelzero/core';`,
      `import { Registry } from '@levelzero/core/registry';`,
      `import type { EnvSourceRegistry } from '@levelzero/core/env/registry';`,
    ].join('\n');
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toEqual([]);
  });

  it('allows third-party npm imports and relative imports', () => {
    const source = [
      `import { z } from 'zod';`,
      `import fs from 'node:fs';`,
      `import { local } from './helpers';`,
      `import { sib } from '../other';`,
    ].join('\n');
    const violations = analyzeSource('f.ts', '@levelzero/plugin-bar', source);
    expect(violations).toEqual([]);
  });

  it('ignores @levelzero/plugin-* mentions inside JSDoc and string literals', () => {
    const source = [
      `/**`,
      ` * Example usage:`,
      ` *`,
      ` * import postgres from '@levelzero/plugin-postgres';`,
      ` */`,
      `export const plugin = { name: '@levelzero/plugin-foo' };`,
      `// import { x } from '@levelzero/plugin-bar';`,
      `throw new Error('@levelzero/plugin-prisma: missing config');`,
    ].join('\n');
    const violations = analyzeSource('f.ts', '@levelzero/plugin-foo', source);
    expect(violations).toEqual([]);
  });

  it('allows the plugin to reference its own package name', () => {
    // Edge case: a plugin importing from itself by name (e.g. via an
    // explicit subpath export) — degenerate but not a composability
    // violation.
    const source = `import { internal } from '@levelzero/plugin-foo/internal';`;
    const violations = analyzeSource('f.ts', '@levelzero/plugin-foo', source);
    expect(violations).toEqual([]);
  });

  it('formats a multi-violation report with file/line/specifier and a pointer to the docs', () => {
    const source = [
      `import a from '@levelzero/plugin-redis';`,
      ``,
      `import b from '@levelzero/template-v0-stack';`,
    ].join('\n');
    const violations = analyzeSource('packages/plugin-foo/src/index.ts', '@levelzero/plugin-foo', source);
    expect(violations).toHaveLength(2);
    const msg = formatViolations(violations);
    expect(msg).toContain("packages/plugin-foo/src/index.ts:1");
    expect(msg).toContain("packages/plugin-foo/src/index.ts:3");
    expect(msg).toContain("@levelzero/plugin-redis");
    expect(msg).toContain("@levelzero/template-v0-stack");
    expect(msg).toContain('docs/EXTENSION.md');
  });
});
