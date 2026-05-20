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
      // LEV-121: Prisma 7 moved the datasource URL out of `schema.prisma`
      // and into a sibling `prisma.config.ts`. Both files must ship.
      'prisma.config.ts',
      // LEV-195: the v0 template ships a basic landing page so the very
      // first request to the web URL after `levelzero dev` renders a real
      // page instead of a 404.
      'apps/web/src/app/page.tsx',
      'apps/web/src/app/layout.tsx',
    ];
    for (const rel of expected) {
      const p = join(templateRoot, rel);
      expect(existsSync(p), `expected ${rel} to exist under templateRoot`).toBe(true);
    }
  });

  it('ships a landing page that checks api health and points at next steps (LEV-195)', () => {
    // Without this page, the first thing a user sees after `levelzero dev` is
    // Next.js's default 404 on a black background — looks broken. The landing
    // page must (a) be a server component that fetches the api's `/api/health`
    // route, (b) reference the editable file path so users know where to go,
    // and (c) name the CLI so they can discover commands. All three are easy
    // to drop in a future refactor; assert them as content fingerprints.
    const page = readFileSync(
      join(templateRoot, 'apps/web/src/app/page.tsx'),
      'utf8',
    );
    expect(/export default async function/.test(page), 'landing page must be an async server component').toBe(true);
    expect(page.includes('/api/health'), 'landing page must hit the api `/api/health` route').toBe(true);
    expect(
      page.includes('process.env.API_URL'),
      'landing page must read the `API_URL` env var the hono plugin injects',
    ).toBe(true);
    expect(
      page.includes('apps/web/src/app/page.tsx'),
      'landing page must name itself so users know which file to edit',
    ).toBe(true);
    expect(
      page.includes('levelzero --help'),
      'landing page must point users at `levelzero --help` for command discovery',
    ).toBe(true);

    // The api app must actually expose `/api/health` so the page's health
    // check has something to hit. Guarding here keeps the two files in sync.
    const apiIndex = readFileSync(
      join(templateRoot, 'apps/api/src/index.ts'),
      'utf8',
    );
    expect(
      /['"]\/api\/health['"]/.test(apiIndex),
      'apps/api/src/index.ts must register a `/api/health` route the landing page can probe',
    ).toBe(true);
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
      // LEV-200 — the api/web templates need the host-allocated ports so they
      // bind to the right port instead of falling back to 3000/3001. The
      // mapping goes through `hono.port` / `next.port` (new EnvSources added
      // alongside the existing `.url` ones).
      ['API_PORT', 'hono.port'],
      ['WEB_URL', 'next.url'],
      ['WEB_PORT', 'next.port'],
    ]) {
      expect(
        config.includes(`${envVar}: '${sourceKey}'`),
        `expected ${envVar} → ${sourceKey} mapping inside envInjection`,
      ).toBe(true);
    }
  });

  it('api + web bind to the levelzero-allocated ports via env (LEV-200)', () => {
    // The api template must read `API_PORT` from env and pass it to bun's
    // `port` export on the default export object so the runtime binds there.
    // Default must NOT be 3000 — that's next dev's port; keep them disjoint
    // outside the harness.
    const apiIndex = readFileSync(
      join(templateRoot, 'apps/api/src/index.ts'),
      'utf8',
    );
    expect(
      apiIndex.includes('API_PORT'),
      'apps/api/src/index.ts must read API_PORT from process.env so levelzero dev can bind it',
    ).toBe(true);
    expect(
      /port\s*:/.test(apiIndex) || /port\s*,/.test(apiIndex),
      'apps/api/src/index.ts must export a `port` field on its default export so bun listens there',
    ).toBe(true);

    // The web template must pass WEB_PORT to `next dev --port`. We check the
    // package.json script substitutes the env var — bun runs the script with
    // shell semantics so `${WEB_PORT:-3000}` resolves the same way `sh -c`
    // would.
    const webPkg = JSON.parse(
      readFileSync(join(templateRoot, 'apps/web/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const devScript = webPkg.scripts?.dev ?? '';
    expect(
      devScript.includes('--port') && devScript.includes('WEB_PORT'),
      `expected web's dev script to pass --port "$WEB_PORT" to next dev; got: ${devScript}`,
    ).toBe(true);
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

  it('prisma setup follows Prisma 7 conventions (LEV-121)', () => {
    // Prisma 7 deprecated `url = env(...)` on the `datasource` block in
    // `schema.prisma`. The URL is now read by `prisma.config.ts` at config
    // load time (via `process.env.DATABASE_URL`). Two guards:
    //   1. schema.prisma's `datasource db { ... }` block must not contain a
    //      `url =` assignment.
    //   2. prisma.config.ts must import `defineConfig` from `prisma/config`
    //      and pass a `datasource.url` derived from `process.env`.
    const schema = readFileSync(join(templateRoot, 'prisma/schema.prisma'), 'utf8');
    const datasourceBlock = schema.match(/datasource\s+\w+\s*\{[^}]*\}/);
    expect(datasourceBlock, 'expected a datasource block in schema.prisma').not.toBeNull();
    expect(
      /\burl\s*=/.test(datasourceBlock?.[0] ?? ''),
      'schema.prisma datasource block must NOT declare `url =` (moved to prisma.config.ts in Prisma 7)',
    ).toBe(false);

    const config = readFileSync(join(templateRoot, 'prisma.config.ts'), 'utf8');
    expect(
      /from\s+['"]prisma\/config['"]/.test(config),
      'prisma.config.ts must import from prisma/config',
    ).toBe(true);
    expect(
      /defineConfig\s*\(/.test(config),
      'prisma.config.ts must call defineConfig(...)',
    ).toBe(true);
    expect(
      config.includes('DATABASE_URL'),
      'prisma.config.ts must reference DATABASE_URL for the datasource',
    ).toBe(true);
  });

  it('ships the .levelzero/skills reference + workflow directories', () => {
    // The skills tree is load-bearing for plan-12's `skills index`; assert a
    // couple of representative files to guard against an accidental drop of
    // the whole `.levelzero/` subtree during future template moves.
    expect(existsSync(join(templateRoot, '.levelzero/skills/workflow/onboard.md'))).toBe(true);
    expect(existsSync(join(templateRoot, '.levelzero/skills/reference/prisma.md'))).toBe(true);
  });
});
