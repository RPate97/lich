/**
 * LEV-215 — forward-regression tests for Prisma 7 compatibility.
 *
 * Two gaps are guarded here:
 *
 *   1. `prismaAdapter.getClient` must use the Prisma 7 driver-adapter
 *      pattern (`new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`)
 *      and NOT the v5/v6 `datasourceUrl` shape. Prisma 7 silently ignores
 *      unknown constructor options at runtime, so a regression that swapped
 *      back to `datasourceUrl` would only surface as ECONNREFUSED at the
 *      first query — too late.
 *
 *   2. `prismaAdapter.newMigration` must NOT pass `--skip-generate` to
 *      `prisma migrate dev --create-only`. Prisma 7 dropped that flag and
 *      now exits with "unknown or unexpected option" if given it.
 *
 * Both tests work by intercepting the constructor / spawn call rather than
 * driving prisma end-to-end — that's covered by the integration tests in
 * `adapter.test.ts`. The point here is a fast unit-level guard that catches
 * the specific shape regression even when docker isn't available.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prismaAdapter } from '../src/adapter';

describe('LEV-215: prismaAdapter.getClient (Prisma 7 driver-adapter)', () => {
  it('constructs PrismaClient with { adapter: PrismaPg(...) }, not { datasourceUrl }', async () => {
    // Capture the options each constructor sees. We patch the two modules
    // BEFORE calling getClient — both must succeed (Prisma 7 chain) and the
    // shape must match what `@prisma/client` expects on v7.
    let prismaClientOpts: unknown;
    let prismaPgOpts: unknown;

    class FakePrismaPg {
      constructor(opts: { connectionString: string }) {
        prismaPgOpts = opts;
      }
    }
    class FakePrismaClient {
      constructor(opts: { adapter: unknown }) {
        prismaClientOpts = opts;
      }
    }

    // Spy on require by intercepting Module._load. createRequire under the
    // hood goes through Module._load, so swapping that out lets us simulate
    // "the consumer has @prisma/client + @prisma/adapter-pg installed" with
    // controlled stubs.
    const Module = await import('node:module');
    const original = (Module.default as unknown as { _load: (req: string, parent: unknown) => unknown })._load;
    (Module.default as unknown as { _load: (req: string, parent: unknown) => unknown })._load = (
      req: string,
      parent: unknown,
    ) => {
      if (req === '@prisma/client') return { PrismaClient: FakePrismaClient };
      if (req === '@prisma/adapter-pg') return { PrismaPg: FakePrismaPg };
      return original.call(Module.default, req, parent);
    };

    try {
      // `getClient` is optional on the `ORMAdapter` shape; the prisma
      // impl always provides it, so we assert presence here rather than
      // gating with `?.()`.
      expect(typeof prismaAdapter.getClient).toBe('function');
      const client = await prismaAdapter.getClient!({
        databaseUrl: 'postgres://u:p@localhost:5432/db',
        projectRoot: '/tmp/lev215-irrelevant',
      });
      expect(client).toBeInstanceOf(FakePrismaClient);
      // PrismaPg must have been constructed with `{ connectionString: ... }`.
      expect(prismaPgOpts).toBeDefined();
      expect((prismaPgOpts as { connectionString?: string }).connectionString).toBe(
        // localhost is rewritten to 127.0.0.1 by `normalizeDatabaseUrlForPg`
        // (LEV-? — works around the IPv6 ECONNREFUSED on dual-stack hosts).
        'postgres://u:p@127.0.0.1:5432/db',
      );
      // PrismaClient must have been constructed with `{ adapter }`, NOT
      // `{ datasourceUrl }`.
      expect(prismaClientOpts).toBeDefined();
      const opts = prismaClientOpts as Record<string, unknown>;
      expect('adapter' in opts, 'PrismaClient must receive an `adapter` option').toBe(true);
      expect(opts['adapter']).toBeInstanceOf(FakePrismaPg);
      expect(
        'datasourceUrl' in opts,
        'PrismaClient must NOT receive `datasourceUrl` (Prisma 7 dropped it)',
      ).toBe(false);
    } finally {
      (Module.default as unknown as { _load: typeof original })._load = original;
    }
  });

  it('throws an actionable error when @prisma/adapter-pg is missing', async () => {
    const Module = await import('node:module');
    const original = (Module.default as unknown as { _load: (req: string, parent: unknown) => unknown })._load;
    (Module.default as unknown as { _load: (req: string, parent: unknown) => unknown })._load = (
      req: string,
      parent: unknown,
    ) => {
      if (req === '@prisma/client') return { PrismaClient: class {} };
      if (req === '@prisma/adapter-pg') {
        throw new Error("Cannot find module '@prisma/adapter-pg'");
      }
      return original.call(Module.default, req, parent);
    };
    try {
      await expect(
        prismaAdapter.getClient!({
          databaseUrl: 'postgres://u:p@localhost:5432/db',
          projectRoot: '/tmp/lev215-irrelevant',
        }),
      ).rejects.toThrow(/@prisma\/adapter-pg/);
    } finally {
      (Module.default as unknown as { _load: typeof original })._load = original;
    }
  });
});

describe('LEV-215: prismaAdapter.newMigration (no --skip-generate)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lz-lev215-mn-')));
    // Materialize the migrations dir + an init migration so the post-spawn
    // `findNewestMigrationDir` lookup finds something to return after we
    // intercept the prisma CLI invocation.
    const initDir = join(projectRoot, 'prisma', 'migrations', '20260101000000_probe');
    mkdirSync(initDir, { recursive: true });
    writeFileSync(join(initDir, 'migration.sql'), '');
  });

  it('does NOT pass --skip-generate to the prisma migrate dev invocation', async () => {
    // We can't easily spy on the named `spawn` import that the adapter
    // module captured at load time, so instead we shadow the `prisma`
    // CLI by writing a fake JS script into `projectRoot/node_modules/
    // prisma/build/index.js` and rely on the adapter's `prismaBinPath()`
    // helper to discover it. The adapter uses `createRequire` from its
    // OWN module URL — so that path always points at the monorepo's
    // hoisted prisma, not our fake. Instead: directly intercept by
    // monkey-patching `child_process.spawn` via `Module._cache` is
    // brittle. Simplest workable approach: spawn a sentinel prisma
    // script under a `PATH` override is also moot (adapter calls Node
    // directly with the resolved JS path).
    //
    // We use Node's vm + Module loader to dynamically reload the
    // adapter module with a stubbed `node:child_process.spawn`. The
    // module cache key for ESM tests under vitest is the file URL; we
    // delete it from `import.meta.cache`-ish state by going through
    // `vi.resetModules()` + `vi.doMock`.
    let capturedArgs: string[] = [];
    vi.doMock('node:child_process', () => ({
      spawn: (_cmd: string, args: readonly string[]) => {
        capturedArgs = [...args];
        // Minimal duck-typed ChildProcess. The adapter attaches listeners
        // for stdout/stderr `data` plus the process-level `error` and
        // `close` events; we just need to fire `close(0)` once.
        const fake = {
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event: string, fn: (...a: unknown[]) => void) => {
            if (event === 'close') {
              queueMicrotask(() => fn(0));
            }
          },
          kill: () => {},
        };
        return fake;
      },
    }));
    vi.resetModules();
    // Re-import the adapter against the mocked child_process.
    const { prismaAdapter: freshAdapter } = await import('../src/adapter');
    try {
      await freshAdapter.newMigration(
        { databaseUrl: 'postgres://u:p@localhost:5432/db', projectRoot },
        'probe',
      );
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
    expect(
      capturedArgs.includes('--skip-generate'),
      `expected --skip-generate NOT in spawn args; got: ${capturedArgs.join(' ')}`,
    ).toBe(false);
    // Sanity: the migrate-dev shape is still intact.
    expect(capturedArgs).toContain('migrate');
    expect(capturedArgs).toContain('dev');
    expect(capturedArgs).toContain('--create-only');
    expect(capturedArgs).toContain('--name');
    expect(capturedArgs).toContain('probe');
  });
});
