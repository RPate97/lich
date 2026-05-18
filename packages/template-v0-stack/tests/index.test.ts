import { describe, it, expect } from 'vitest';
import { statSync, existsSync, readFileSync } from 'node:fs';
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

  it('levelzero.config.ts imports and declares every v0 plugin', () => {
    // The scaffolded config is what makes a fresh `levelzero init` project
    // actually runnable — after Tier 5 the core ships zero built-in adapters,
    // so every slot has to be filled by a plugin declared here. Guard against
    // accidental drops/renames with a literal string match on each import line
    // plus the `plugins:` array entry.
    const config = readFileSync(join(templateRoot, 'levelzero.config.ts'), 'utf8');
    const expectedPlugins: Array<{ binding: string; pkg: string }> = [
      { binding: 'postgres', pkg: '@levelzero/plugin-postgres' },
      { binding: 'prisma', pkg: '@levelzero/plugin-prisma' },
      { binding: 'hono', pkg: '@levelzero/plugin-hono' },
      { binding: 'typedClient', pkg: '@levelzero/plugin-typed-client' },
      { binding: 'betterAuth', pkg: '@levelzero/plugin-better-auth' },
      { binding: 'shadcn', pkg: '@levelzero/plugin-shadcn' },
      { binding: 'next', pkg: '@levelzero/plugin-next' },
      { binding: 'vitest', pkg: '@levelzero/plugin-vitest' },
      { binding: 'playwright', pkg: '@levelzero/plugin-playwright' },
    ];
    for (const { binding, pkg } of expectedPlugins) {
      expect(
        config.includes(`import ${binding} from '${pkg}';`),
        `expected import line for ${pkg} (as ${binding})`,
      ).toBe(true);
      // LEV-186: plugins are now factories, so each binding must appear as
      // `<binding>()` inside the plugins array — not as a bare reference.
      const pluginsBody = config.split('plugins:')[1] ?? '';
      expect(
        new RegExp(`\\b${binding}\\(\\)`).test(pluginsBody),
        `expected ${binding}() call in the plugins array`,
      ).toBe(true);
    }
  });

  it('levelzero.config.ts uses defineConfig and declares an envInjection block (LEV-187)', () => {
    // Post-LEV-187 every v0 plugin publishes its env values through
    // `api.addEnvSource()`, so the scaffolded config maps DATABASE_URL /
    // API_URL / WEB_URL to the qualified source keys exposed by the
    // postgres / hono / next plugins. `defineConfig` is the typed-authoring
    // wrapper (LEV-180) that flows the plugin tuple types into autocomplete
    // on these values.
    const config = readFileSync(join(templateRoot, 'levelzero.config.ts'), 'utf8');
    expect(
      config.includes(`import { defineConfig } from '@levelzero/core';`),
      'expected defineConfig import from @levelzero/core',
    ).toBe(true);
    expect(
      /export default defineConfig\(/.test(config),
      'expected the config to be wrapped in defineConfig(...)',
    ).toBe(true);

    for (const [envVar, sourceKey] of [
      ['DATABASE_URL', 'postgres.url'],
      ['API_URL', 'hono.url'],
      ['WEB_URL', 'next.url'],
    ]) {
      expect(
        config.includes(`${envVar}: '${sourceKey}'`),
        `expected ${envVar} → ${sourceKey} mapping inside envInjection`,
      ).toBe(true);
    }
  });

  it('package.json declares every v0 plugin as a dependency', () => {
    // Mirror of the config test: every plugin imported by the scaffolded
    // levelzero.config.ts must also be a dependency so `bun install` resolves
    // it (via workspace symlink in the monorepo, via npm in a real project).
    const pkg = JSON.parse(
      readFileSync(join(templateRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    const expected = [
      '@levelzero/plugin-postgres',
      '@levelzero/plugin-prisma',
      '@levelzero/plugin-hono',
      '@levelzero/plugin-typed-client',
      '@levelzero/plugin-better-auth',
      '@levelzero/plugin-shadcn',
      '@levelzero/plugin-next',
      '@levelzero/plugin-vitest',
      '@levelzero/plugin-playwright',
    ];
    for (const name of expected) {
      expect(deps[name], `expected ${name} in dependencies`).toBeTruthy();
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
