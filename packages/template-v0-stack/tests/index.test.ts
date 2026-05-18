import { describe, it, expect } from 'vitest';
import { statSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { templateRoot } from '../src/index';

describe('@levelzero/template-v0-stack', () => {
  it('exports an absolute path', () => {
    expect(typeof templateRoot).toBe('string');
    expect(isAbsolute(templateRoot)).toBe(true);
  });

  it('templateRoot points at an existing directory', () => {
    expect(existsSync(templateRoot)).toBe(true);
    expect(statSync(templateRoot).isDirectory()).toBe(true);
  });

  it('directory contains the canonical v0 scaffolded files', () => {
    // The scaffolder entry points users hit most directly: the project root
    // package.json, the CLI config, the CLAUDE.md, and the apps/ subtree.
    const expected = [
      'package.json',
      'levelzero.config.ts',
      'CLAUDE.md',
      'tsconfig.json',
      'turbo.json',
      'apps/web/package.json',
      'apps/api/package.json',
      'prisma/schema.prisma',
    ];
    for (const rel of expected) {
      const p = join(templateRoot, rel);
      expect(existsSync(p), `expected ${rel} to exist under templateRoot`).toBe(true);
    }
  });

  it('ships the .levelzero/skills reference + workflow directories', () => {
    // The skills tree is load-bearing for plan-12's `skills index`; assert a
    // couple of representative files to guard against an accidental drop of
    // the whole `.levelzero/` subtree during future template moves.
    expect(existsSync(join(templateRoot, '.levelzero/skills/workflow/onboard.md'))).toBe(true);
    expect(existsSync(join(templateRoot, '.levelzero/skills/reference/prisma.md'))).toBe(true);
  });
});
