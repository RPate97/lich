import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Create a minimal Prisma project directory tree in a tmpdir.
 * Returns the absolute projectRoot. The schema has a `User` model and one
 * empty `init` migration directory (so deploy is a no-op).
 *
 * LEV-204: this fixture deliberately mirrors the real v0 demo layout —
 *
 *   <projectRoot>/
 *     package.json              ← declares `prisma` as a direct devDep
 *     prisma.config.ts          ← imports from `'prisma/config'`
 *     prisma/schema.prisma
 *     prisma/migrations/...
 *     apps/api/package.json     ← nested workspace member, NO prisma dep
 *     node_modules/             ← prisma symlinked here (see below)
 *
 * The earlier fixture wrote just `prisma.config.ts` + the schema into a
 * tmpdir with no `package.json` and relied on the surrounding monorepo's
 * hoisted `prisma` package for resolution. That doesn't replicate the bug
 * class LEV-204 exposed: in a freshly scaffolded demo, the only `prisma`
 * reachable from the project root is whatever bun installed there — there's
 * no parent monorepo `node_modules/` to fall back on. (And worse, the
 * monorepo's HOISTED `prisma` is v5 because `@lich/core` declares
 * `prisma: ^5.18.0`, while plugin-prisma declares `^7.0.0`. So even when
 * the old fixture's tmpdir happened to be under the monorepo, the resolver
 * found v5, which doesn't have the `config` subpath — and the integration
 * tests broke silently the moment LEV-121 introduced `prisma.config.ts`.)
 *
 * Putting `prisma` at the ROOT (not at `apps/api/`) is the whole point —
 * `prisma.config.ts` lives at the root, so the resolver walks
 * `<root>/node_modules` first. Having `apps/api/` as a nested workspace
 * (without its own prisma dep) catches the LEV-204 regression class: if a
 * future change moves `prisma` into `apps/api`'s deps and removes it from
 * the root, the resolver won't find it from `prisma.config.ts` and every
 * `db.*` command breaks again.
 *
 * Prisma 7 (LEV-121): the datasource URL no longer lives on the schema's
 * `datasource db { ... }` block — it's read from `prisma.config.ts` at
 * config load time. The schema keeps `provider = "postgresql"`; the URL
 * comes from `process.env.DATABASE_URL` via the config file. The adapter
 * itself sets DATABASE_URL on every CLI invocation, so this fixture doesn't
 * need a separate `.env` file.
 */
export function makePrismaFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prisma-fixture-')));

  // --- workspace hierarchy ---------------------------------------------------
  // Root package.json declares a workspace + lists `prisma` as a direct
  // devDep. apps/api is a workspace member with NO prisma dep — that
  // mirrors the real v0 template (LEV-204), where `prisma.config.ts` at the
  // root needs to resolve `prisma/config` from `<root>/node_modules`, not
  // from `apps/api/node_modules`.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'lz-prisma-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        workspaces: ['apps/*'],
        devDependencies: {
          prisma: '^7.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  );

  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  writeFileSync(
    join(root, 'apps', 'api', 'package.json'),
    JSON.stringify(
      {
        name: 'lz-prisma-fixture-api',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
  );

  // --- prisma schema + migration --------------------------------------------
  mkdirSync(join(root, 'prisma', 'migrations', '20260101000000_init'), {
    recursive: true,
  });
  // Prisma 5+ rejects compact single-line generator/datasource blocks. Each
  // attribute must be on its own line.
  writeFileSync(
    join(root, 'prisma', 'schema.prisma'),
    `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  createdAt DateTime @default(now())
}
`.trim() + '\n',
  );
  writeFileSync(
    join(root, 'prisma.config.ts'),
    `
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
`.trim() + '\n',
  );
  writeFileSync(
    join(root, 'prisma', 'migrations', '20260101000000_init', 'migration.sql'),
    `CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
  );
  writeFileSync(
    join(root, 'prisma', 'migrations', 'migration_lock.toml'),
    'provider = "postgresql"\n',
  );

  // --- materialize node_modules/prisma --------------------------------------
  // We need `<root>/node_modules/prisma/config` reachable from
  // `<root>/prisma.config.ts` at CLI-invocation time. Running `bun install`
  // for every fixture would be too slow (30-60s/test); instead we locate
  // the v7 `prisma` install that's already on disk (plugin-prisma's own
  // `node_modules/prisma` — pinned to v7 by this package's package.json)
  // and symlink it into the fixture root. Symlinks are O(ms).
  //
  // If for any reason the v7 install isn't reachable (e.g. CI hasn't run
  // `bun install` yet, or someone moved the hoist point), we fall back to
  // a real `bun install` in the fixture — slow, but correct.
  const targetNodeModules = join(root, 'node_modules');
  mkdirSync(targetNodeModules, { recursive: true });

  const prismaSrc = findPrismaV7Install();
  if (prismaSrc) {
    linkPackageTree(targetNodeModules, prismaSrc);
  } else {
    const r = spawnSync('bun', ['install'], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
    });
    if (r.status !== 0) {
      throw new Error(
        `prisma-fixture: bun install fallback failed (exit ${r.status})\n` +
          `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }
  }

  return root;
}

/**
 * Locate the monorepo's `prisma` v7 install directory. Returns the
 * absolute path to the directory containing `prisma/package.json`, or
 * `null` if no v7 install is reachable from this file's location.
 *
 * Why this matters: the monorepo currently has BOTH `prisma: ^5.18.0` (via
 * `@lich/core`) and `prisma: ^7.0.0` (via `@lich/plugin-prisma`)
 * in its dep graph. Bun deduplicates, and the version that lands at
 * `<repo>/node_modules/prisma` (hoisted) is v5 — the older major dominates
 * because of the wider range. We specifically need v7 here because the
 * `config` subpath export only exists in v7. `createRequire(import.meta
 * .url)` resolves from THIS file's location (inside `packages/plugin-
 * prisma`), so node walks up and finds `packages/plugin-prisma/node_modules
 * /prisma` first — which IS v7 (this package pins it that way). We then
 * verify the package's `version` actually starts with `7.` so a future
 * dedupe/hoist change can't silently swap us back to v5.
 */
function findPrismaV7Install(): string | null {
  const localRequire = createRequire(import.meta.url);
  try {
    const pkgPath = localRequire.resolve('prisma/package.json');
    const pkgDir = dirname(pkgPath);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && /^7\./.test(pkg.version)) {
      return pkgDir;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Symlink `prisma` and every `@prisma/*` package from the host's
 * node_modules into the fixture's node_modules. We can't symlink only the
 * `prisma` directory because prisma's CLI requires sibling packages like
 * `@prisma/config`, `@prisma/engines`, etc. — those resolve from the same
 * node_modules parent the `prisma` package lives in.
 */
function linkPackageTree(targetNodeModules: string, prismaSrcDir: string): void {
  const hostNodeModules = dirname(prismaSrcDir);
  symlinkSync(prismaSrcDir, join(targetNodeModules, 'prisma'), 'dir');

  const atPrismaSrc = join(hostNodeModules, '@prisma');
  if (existsSync(atPrismaSrc)) {
    const atPrismaTarget = join(targetNodeModules, '@prisma');
    mkdirSync(atPrismaTarget, { recursive: true });
    for (const entry of readdirSync(atPrismaSrc)) {
      symlinkSync(
        join(atPrismaSrc, entry),
        join(atPrismaTarget, entry),
        'dir',
      );
    }
  }
}
