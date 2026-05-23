import { describe, it, expect } from 'vitest';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { templateRoot } from '../src/index';

describe('@lich/template-v0-stack', () => {
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
      'lich.config.ts',
      'CLAUDE.md',
      'tsconfig.json',
      'apps/web/package.json',
      'apps/api/package.json',
      'prisma/schema.prisma',
      // LEV-121: Prisma 7 moved the datasource URL out of `schema.prisma`
      // and into a sibling `prisma.config.ts`. Both files must ship.
      'prisma.config.ts',
      // LEV-195: the v0 template ships a basic landing page so the very
      // first request to the web URL after `lich up` renders a real
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
    // Without this page, the first thing a user sees after `lich up` is
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
      page.includes('lich --help'),
      'landing page must point users at `lich --help` for command discovery',
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

  it('lich.config.ts imports and declares every v0 plugin', () => {
    // The scaffolded config is what makes a fresh `lich init` project
    // actually runnable — after Tier 5 the core ships zero built-in adapters,
    // so every slot has to be filled by a plugin declared here. Guard against
    // accidental drops/renames with a literal string match on each import line
    // plus the `plugins:` array entry.
    const config = readFileSync(join(templateRoot, 'lich.config.ts'), 'utf8');
    const expectedPlugins: Array<{ binding: string; pkg: string }> = [
      { binding: 'postgres', pkg: '@lich/plugin-postgres' },
      { binding: 'prisma', pkg: '@lich/plugin-prisma' },
      { binding: 'hono', pkg: '@lich/plugin-hono' },
      { binding: 'typedClient', pkg: '@lich/plugin-typed-client' },
      { binding: 'betterAuth', pkg: '@lich/plugin-better-auth' },
      { binding: 'shadcn', pkg: '@lich/plugin-shadcn' },
      { binding: 'next', pkg: '@lich/plugin-next' },
      { binding: 'vitest', pkg: '@lich/plugin-vitest' },
      { binding: 'playwright', pkg: '@lich/plugin-playwright' },
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

  it('lich.config.ts uses defineConfig and declares an envInjection block (LEV-187)', () => {
    // Post-LEV-187 every v0 plugin publishes its env values through
    // `api.addEnvSource()`, so the scaffolded config maps DATABASE_URL /
    // API_URL / WEB_URL to the qualified source keys exposed by the
    // postgres / hono / next plugins. `defineConfig` is the typed-authoring
    // wrapper (LEV-180) that flows the plugin tuple types into autocomplete
    // on these values.
    const config = readFileSync(join(templateRoot, 'lich.config.ts'), 'utf8');
    expect(
      config.includes(`import { defineConfig } from '@lich/core';`),
      'expected defineConfig import from @lich/core',
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

  it('api + web bind to the lich-allocated ports via env (LEV-200)', () => {
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
      'apps/api/src/index.ts must read API_PORT from process.env so lich up can bind it',
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
    // lich.config.ts must also be a dependency so `bun install` resolves
    // it (via workspace symlink in the monorepo, via npm in a real project).
    const pkg = JSON.parse(
      readFileSync(join(templateRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    const expected = [
      '@lich/plugin-postgres',
      '@lich/plugin-prisma',
      '@lich/plugin-hono',
      '@lich/plugin-typed-client',
      '@lich/plugin-better-auth',
      '@lich/plugin-shadcn',
      '@lich/plugin-next',
      '@lich/plugin-vitest',
      '@lich/plugin-playwright',
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

  it('package.json declares @lich/core as a direct devDependency (LEV-205)', () => {
    // LEV-205: the template lists `@lich/plugin-*` but used to omit
    // `@lich/core`. Plugins all depend on core transitively, but bun
    // won't materialize a top-level `node_modules/.bin/lich` from a
    // transitive — so `bun run lich --help` would die with "Script not
    // found 'lich'" in a fresh scaffold. The fix is to declare core
    // directly here so its `bin` entry lands at the demo root. Forward
    // regression guard: if a future refactor drops this line, the
    // documented first-run flow breaks again.
    const pkg = JSON.parse(
      readFileSync(join(templateRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared =
      pkg.dependencies?.['@lich/core'] ??
      pkg.devDependencies?.['@lich/core'];
    expect(
      declared,
      'expected `@lich/core` to be declared at the template root so `node_modules/.bin/lich` resolves after `bun install`',
    ).toBeTruthy();
  });

  it('package.json declares prisma as a devDependency (LEV-204)', () => {
    // LEV-204: `prisma.config.ts` at the project root imports from
    // `'prisma/config'` (Prisma 7's subpath export). Bun's module resolver
    // walks `node_modules` upward from the importing file's directory, so
    // unless `prisma` is hoisted to the demo root `node_modules`, every
    // `db.*` command (migrate / seed / inspect / reset) and `gen --only
    // prisma` blow up with "Cannot find module 'prisma/config'".
    //
    // The fix is to pin `prisma` at the template root so a scaffolded
    // project gets `node_modules/prisma/` reachable from `prisma.config.ts`.
    // Pinning the major version here (in lockstep with `@lich/plugin-
    // prisma`'s own `prisma` dep) is what prevents bun from hoisting an
    // older v5 transitive that wouldn't have the `config` subpath at all.
    const pkg = JSON.parse(
      readFileSync(join(templateRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const devDeps = pkg.devDependencies ?? {};
    expect(
      devDeps['prisma'],
      'expected `prisma` in devDependencies so prisma.config.ts can resolve `prisma/config`',
    ).toBeTruthy();
    // Must be v7+ — that's where the `config` subpath export was added.
    expect(devDeps['prisma']).toMatch(/^[\^~]?7\./);
  });

  it('ships the .lich/skills reference + workflow directories', () => {
    // The skills tree is load-bearing for plan-12's `skills index`; assert a
    // couple of representative files to guard against an accidental drop of
    // the whole `.lich/` subtree during future template moves.
    expect(existsSync(join(templateRoot, '.lich/skills/workflow/onboard.md'))).toBe(true);
    expect(existsSync(join(templateRoot, '.lich/skills/reference/prisma.md'))).toBe(true);
  });

  it('ships the LEV-196 auth + todo CRUD scaffolding', () => {
    // LEV-196 turns the v0 template into a tangibly-working app: sign-up,
    // sign-in, dashboard, todo CRUD, sign-out. The structural fingerprints
    // below catch accidental drops/renames of the load-bearing files. Each
    // assertion is a content fingerprint — we don't try to parse the file,
    // just look for a load-bearing identifier or import string.

    // ── prisma: Todo domain model lives alongside the Better Auth tables.
    const schema = readFileSync(join(templateRoot, 'prisma/schema.prisma'), 'utf8');
    expect(
      /\bmodel\s+Todo\s*\{/.test(schema),
      'expected `model Todo { ... }` in prisma/schema.prisma',
    ).toBe(true);
    expect(
      /todos\s+Todo\[\]/.test(schema),
      'expected User.todos relation in prisma/schema.prisma',
    ).toBe(true);

    // ── api: Better Auth instance and Hono mount, plus the todo CRUD routes.
    expect(existsSync(join(templateRoot, 'apps/api/src/auth.ts'))).toBe(true);
    const authTs = readFileSync(join(templateRoot, 'apps/api/src/auth.ts'), 'utf8');
    expect(
      authTs.includes('betterAuth(') && authTs.includes('prismaAdapter'),
      'apps/api/src/auth.ts must construct a betterAuth() with the prisma adapter',
    ).toBe(true);

    const apiIndex = readFileSync(join(templateRoot, 'apps/api/src/index.ts'), 'utf8');
    expect(
      apiIndex.includes(`from './auth'`),
      'apps/api/src/index.ts must import the shared auth instance',
    ).toBe(true);
    expect(
      /['"]\/api\/auth\/\*['"]/.test(apiIndex),
      'apps/api/src/index.ts must mount Better Auth under /api/auth/*',
    ).toBe(true);
    expect(
      /['"]\/api\/todos['"]/.test(apiIndex),
      'apps/api/src/index.ts must declare a /api/todos route',
    ).toBe(true);
    expect(
      /['"]\/api\/todos\/:id['"]/.test(apiIndex),
      'apps/api/src/index.ts must declare a /api/todos/:id route',
    ).toBe(true);
    expect(
      apiIndex.includes('getSession'),
      'apps/api/src/index.ts must guard todo routes with a session check',
    ).toBe(true);
    // The default export must expose `routes` so `lich gen --only
    // api-client`'s hono extractor can walk the route table even after we
    // moved to a Bun-shaped `{ fetch, port }` export.
    expect(
      /routes\s*:/.test(apiIndex),
      'apps/api/src/index.ts default export must include `routes` so the typed-client generator can extract them',
    ).toBe(true);

    // ── api deps include better-auth + @prisma/client + @prisma/adapter-pg.
    // LEV-218: apps/api/src/prisma.ts imports both `@prisma/client` AND
    // `@prisma/adapter-pg` (PrismaPg). If either is missing from the api's
    // package.json the scaffolded api crashes on startup with "@prisma/client
    // did not initialize yet". Both must be declared as explicit dependencies
    // so `bun install` materialises them in the api's node_modules.
    const apiPkg = JSON.parse(
      readFileSync(join(templateRoot, 'apps/api/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(apiPkg.dependencies?.['better-auth']).toBeTruthy();
    expect(
      apiPkg.dependencies?.['@prisma/client'],
      'apps/api/package.json must declare @prisma/client (imported by src/prisma.ts) — LEV-218',
    ).toBeTruthy();
    expect(
      apiPkg.dependencies?.['@prisma/adapter-pg'],
      'apps/api/package.json must declare @prisma/adapter-pg (PrismaPg imported by src/prisma.ts) — LEV-218',
    ).toBeTruthy();
    expect(apiPkg.dependencies?.['hono']).toBeTruthy();

    // ── web: pages for sign-in / sign-up / dashboard, plus the form
    //    components and lib files. The accessible-name fingerprints
    //    ("Add", "Sign out", "[name=todo-text]", etc.) are what the e2e
    //    spec drives, so we lock them in here too.
    expect(existsSync(join(templateRoot, 'apps/web/src/app/sign-in/page.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/app/sign-up/page.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/app/dashboard/page.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/components/sign-in-form.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/components/sign-up-form.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/components/todo-list.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/components/sign-out-button.tsx'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/lib/auth-client.ts'))).toBe(true);
    expect(existsSync(join(templateRoot, 'apps/web/src/lib/api.ts'))).toBe(true);

    const todoList = readFileSync(
      join(templateRoot, 'apps/web/src/components/todo-list.tsx'),
      'utf8',
    );
    expect(
      todoList.includes('name="todo-text"'),
      '<TodoList> input must use name="todo-text" so the e2e spec can fill it',
    ).toBe(true);
    expect(
      /Add\b/.test(todoList) && /Delete\b/.test(todoList),
      '<TodoList> must render "Add" and "Delete" buttons so the e2e spec can click them',
    ).toBe(true);

    const signInForm = readFileSync(
      join(templateRoot, 'apps/web/src/components/sign-in-form.tsx'),
      'utf8',
    );
    expect(
      signInForm.includes('name="email"') && signInForm.includes('name="password"'),
      '<SignInForm> must use [name=email] + [name=password] so the e2e spec can fill them',
    ).toBe(true);
    expect(
      signInForm.includes(`authClient.signIn.email`),
      '<SignInForm> must call authClient.signIn.email',
    ).toBe(true);

    const signUpForm = readFileSync(
      join(templateRoot, 'apps/web/src/components/sign-up-form.tsx'),
      'utf8',
    );
    expect(
      signUpForm.includes(`authClient.signUp.email`),
      '<SignUpForm> must call authClient.signUp.email',
    ).toBe(true);

    // ── web depends on better-auth.
    const webPkg = JSON.parse(
      readFileSync(join(templateRoot, 'apps/web/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(webPkg.dependencies?.['better-auth']).toBeTruthy();

    // ── seed has the demo user + 3 demo todos.
    const seed = readFileSync(join(templateRoot, 'prisma/seed.ts'), 'utf8');
    expect(
      seed.includes('demo@example.com'),
      'prisma/seed.ts must create the demo@example.com user',
    ).toBe(true);
    expect(
      seed.includes(`auth.api.signUpEmail`),
      'prisma/seed.ts must use Better Auth signUpEmail so the password is hashed correctly',
    ).toBe(true);

    // ── e2e spec lives in the template too.
    expect(existsSync(join(templateRoot, 'e2e/auth-flow.spec.ts'))).toBe(true);
    const e2e = readFileSync(join(templateRoot, 'e2e/auth-flow.spec.ts'), 'utf8');
    expect(
      e2e.includes('@playwright/test'),
      'e2e/auth-flow.spec.ts must import from @playwright/test',
    ).toBe(true);
    expect(
      e2e.includes('full auth + todo flow'),
      'e2e/auth-flow.spec.ts must keep the canonical test name',
    ).toBe(true);
  });

  it('ships an initial prisma migration with auth + Todo tables (LEV-215)', () => {
    // LEV-215: pre-fix the template shipped NO `prisma/migrations/`
    // directory, so `lich db migrate` in a freshly-scaffolded project
    // was a no-op — `prisma migrate deploy` finds no migrations to apply
    // and the auth + Todo tables never get created. `db seed` then trips
    // on `relation "User" does not exist`. The fix is to generate an
    // initial migration via a real postgres + `prisma migrate dev
    // --create-only` and commit the resulting SQL into the template
    // tree at `prisma/migrations/0_init/migration.sql`. The
    // `migration_lock.toml` sibling declares the provider so prisma
    // refuses to apply the migration set against a non-postgres driver
    // (a sane safety check we want preserved).
    const migrationsDir = join(templateRoot, 'prisma/migrations');
    expect(
      existsSync(migrationsDir),
      'template must ship prisma/migrations/ so db migrate creates tables in a fresh scaffold',
    ).toBe(true);
    const lock = join(migrationsDir, 'migration_lock.toml');
    expect(
      existsSync(lock),
      'prisma/migrations/migration_lock.toml must ship so prisma knows the driver',
    ).toBe(true);
    expect(readFileSync(lock, 'utf8')).toMatch(/provider\s*=\s*"postgresql"/);

    const initSqlPath = join(migrationsDir, '0_init/migration.sql');
    expect(
      existsSync(initSqlPath),
      'prisma/migrations/0_init/migration.sql must ship so `db migrate` materializes the schema',
    ).toBe(true);
    const initSql = readFileSync(initSqlPath, 'utf8');

    // The SQL must CREATE TABLE for every model the LEV-196 template
    // depends on at runtime. Anything missing here means a fresh scaffold
    // will hit a `relation does not exist` error from `db seed` (or from
    // the Better Auth sign-up handler that the dashboard hits on first
    // visit). We assert the table names literally; prisma quotes
    // identifiers with double quotes so we match `CREATE TABLE "<Name>"`.
    const requiredTables = ['User', 'Session', 'Account', 'Verification', 'Todo'];
    for (const t of requiredTables) {
      expect(
        new RegExp(`CREATE TABLE\\s+"${t}"`).test(initSql),
        `expected CREATE TABLE "${t}" in 0_init/migration.sql`,
      ).toBe(true);
    }
    // The Todo → User FK is what enforces the per-user ownership model
    // that `apps/api/src/index.ts`'s todo routes rely on. A regression
    // that drops the FK would silently weaken auth without breaking
    // anything obvious until production.
    expect(
      /ALTER TABLE\s+"Todo"\s+ADD CONSTRAINT[^;]*FOREIGN KEY[^;]*REFERENCES\s+"User"/i.test(
        initSql,
      ),
      'Todo.userId → User FK constraint must be present in 0_init/migration.sql',
    ).toBe(true);
  });

  it('root dev script invokes the lich CLI, not turbo (LEV-216)', () => {
    // LEV-216: scaffolding inside a turbo-managed monorepo (or even
    // standalone) blew up at first `bun run dev` because the template's root
    // dev script was `turbo run dev` and a `turbo.json` shipped at the root.
    // Turbo then walked the ancestor tree, found the parent workspace, and
    // refused the sub-workspace config with "No 'extends' key found." More
    // fundamentally: `turbo run dev` skips compose + port allocation + env
    // injection — the whole point of `lich up`. The first command users
    // run after install MUST bring the full stack up via the CLI.
    const pkg = JSON.parse(
      readFileSync(join(templateRoot, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(
      pkg.scripts?.dev,
      'root dev script must be `lich up` so the first run brings up compose + api + web with port allocation',
    ).toBe('lich up');
    // Turbo MUST be gone — the template no longer orchestrates anything via
    // turbo, and leaving a stale dep would silently re-add a `turbo.json`
    // expectation on `bun install` if a user added back a `turbo run *`
    // script without thinking about it.
    expect(
      pkg.devDependencies?.['turbo'],
      'turbo must not be a devDependency in the scaffolded template — see LEV-216',
    ).toBeUndefined();
    // turbo.json at the template root made turbo treat the scaffold as a
    // sub-workspace when nested inside another monorepo. Don't ship it.
    expect(
      existsSync(join(templateRoot, 'turbo.json')),
      'turbo.json must not ship in the v0 template — see LEV-216',
    ).toBe(false);
  });

  it('apps/api/package.json declares @prisma/client and @prisma/adapter-pg as dependencies (LEV-218)', () => {
    // LEV-218: apps/api/src/prisma.ts imports BOTH `@prisma/client`
    // (PrismaClient) AND `@prisma/adapter-pg` (PrismaPg). Without explicit
    // entries in `dependencies`, bun may not hoist the packages into the api
    // workspace's node_modules, causing the runtime error:
    //   "@prisma/client did not initialize yet. Please run "prisma generate"..."
    // Versions must match the template root's `prisma` devDependency pin (^7.x)
    // so a single `prisma generate` at the root produces a client the api can
    // resolve.
    const apiPkg = JSON.parse(
      readFileSync(join(templateRoot, 'apps/api/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = apiPkg.dependencies ?? {};

    expect(
      deps['@prisma/client'],
      'apps/api/package.json must declare @prisma/client in dependencies (imported by src/prisma.ts)',
    ).toBeTruthy();
    expect(
      deps['@prisma/adapter-pg'],
      'apps/api/package.json must declare @prisma/adapter-pg in dependencies (PrismaPg imported by src/prisma.ts)',
    ).toBeTruthy();

    // Both packages must be pinned to Prisma 7.x — the same major as the root
    // devDependency `"prisma": "^7.0.0"` — so a single `prisma generate` at
    // the scaffold root produces a client binary the api imports.
    expect(deps['@prisma/client']).toMatch(
      /^[\^~]?7\./,
      '@prisma/client version must be ^7.x to match the template root prisma devDependency',
    );
    expect(deps['@prisma/adapter-pg']).toMatch(
      /^[\^~]?7\./,
      '@prisma/adapter-pg version must be ^7.x to match the template root prisma devDependency',
    );
  });
});
