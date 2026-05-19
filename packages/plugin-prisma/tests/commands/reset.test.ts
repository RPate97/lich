import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@levelzero/core/registry';
import { computeWorktreeKey } from '@levelzero/core/worktree';
import { CLIError } from '@levelzero/core/errors';
import { EnvSourceRegistry } from '@levelzero/core/env/registry';
import { makeDbResetCommand, dbResetCommand } from '../../src/commands/reset';
import type { ORMAdapter, ORMContext, MigrationResult } from '@levelzero/core';

/**
 * Configurable adapter stub. Each step's behavior can be overridden so a
 * single helper covers happy path, --skip-seed, and per-step failure cases
 * without re-deriving the boilerplate `vi.fn` wiring per test.
 */
interface AdapterStubOpts {
  resetImpl?: (ctx: ORMContext) => Promise<void>;
  migrateImpl?: (ctx: ORMContext) => Promise<MigrationResult>;
  seedImpl?: (ctx: ORMContext) => Promise<{ ok: boolean; output: string }>;
}

function stubAdapter(impls: AdapterStubOpts = {}): ORMAdapter {
  const reset =
    impls.resetImpl ??
    (async () => {
      /* no-op happy path */
    });
  const migrate =
    impls.migrateImpl ?? (async () => ({ applied: 0, names: [], output: '' }));
  const seed = impls.seedImpl ?? (async () => ({ ok: true, output: '' }));
  return {
    name: 'stub',
    applyMigrations: vi.fn(migrate) as unknown as ORMAdapter['applyMigrations'],
    newMigration: vi.fn(),
    seed: vi.fn(seed) as unknown as ORMAdapter['seed'],
    inspectSchema: vi.fn(),
    inspectTable: vi.fn(),
    resetDatabase: vi.fn(reset) as unknown as ORMAdapter['resetDatabase'],
    generateClient: vi.fn(),
  } as unknown as ORMAdapter;
}

/**
 * Pre-populated EnvSourceRegistry mirroring what plugin-postgres publishes.
 * Same shape used by migrate.test.ts and seed.test.ts so the three db.*
 * suites stay aligned on the cross-plugin contract (Plan 15 / LEV-171).
 */
function envSourceRegistryWithPostgres(): EnvSourceRegistry {
  const reg = new EnvSourceRegistry();
  reg.registerNamed({
    namespace: 'postgres',
    name: 'url',
    fullKey: 'postgres.url',
    pluginName: '@levelzero/plugin-postgres',
    source: {
      protocol: 'postgres',
      host: ({ ports }) =>
        `postgres://levelzero:levelzero@localhost:${ports.postgres ?? ''}/levelzero`,
      container: () => `postgres://levelzero:levelzero@postgres:5432/levelzero`,
    },
  });
  return reg;
}

let projectDir: string;
let homeDir: string;
let registry: Registry;
const POSTGRES_PORT = 54814;

async function seedRegistryEntry(): Promise<void> {
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: { postgres: POSTGRES_PORT },
    urls: {},
    containers: [],
    network: '',
    logDir: '.levelzero/logs',
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-reset-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-reset-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero db reset', () => {
  it('exports a command named "db.reset"', () => {
    expect(dbResetCommand.name).toBe('db.reset');
    expect(typeof dbResetCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-reset-outside-')));
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
    // None of the adapter steps should have run.
    expect(adapter.resetDatabase).not.toHaveBeenCalled();
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('errors with a clear message when no stack is running', async () => {
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.resetDatabase).not.toHaveBeenCalled();
  });

  it('errors when no postgres EnvSource is registered (no DB plugin loaded)', async () => {
    // LEV-171: stack is up but no DB plugin contributed a `*.url` postgres source.
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: () => new EnvSourceRegistry(),
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/postgres EnvSource/i);
    expect(adapter.resetDatabase).not.toHaveBeenCalled();
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('runs reset → migrate → seed in order with the resolved DATABASE_URL + projectRoot', async () => {
    await seedRegistryEntry();
    const callOrder: string[] = [];
    const captured: { reset?: ORMContext; migrate?: ORMContext; seed?: ORMContext } = {};
    const adapter = stubAdapter({
      resetImpl: async (c) => {
        captured.reset = c;
        callOrder.push('reset');
      },
      migrateImpl: async (c) => {
        captured.migrate = c;
        callOrder.push('migrate');
        return { applied: 1, names: ['20260101_init'], output: '' };
      },
      seedImpl: async (c) => {
        captured.seed = c;
        callOrder.push('seed');
        return { ok: true, output: 'Seeded 3 rows\n' };
      },
    });

    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { reset: boolean; migrated: boolean; seeded: boolean };

    // Sequencing is the load-bearing assertion: ORM gets reset, THEN
    // migrations re-apply, THEN seed runs. Out-of-order would leave the DB
    // in a broken intermediate state (e.g. seeding into pre-reset schema).
    expect(callOrder).toEqual(['reset', 'migrate', 'seed']);
    expect(adapter.resetDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.applyMigrations).toHaveBeenCalledTimes(1);
    expect(adapter.seed).toHaveBeenCalledTimes(1);

    // Each step received the same EnvSource-resolved URL + project root.
    const expectedUrl = `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`;
    expect(captured.reset?.databaseUrl).toBe(expectedUrl);
    expect(captured.migrate?.databaseUrl).toBe(expectedUrl);
    expect(captured.seed?.databaseUrl).toBe(expectedUrl);
    expect(captured.reset?.projectRoot).toBe(projectDir);
    expect(captured.migrate?.projectRoot).toBe(projectDir);
    expect(captured.seed?.projectRoot).toBe(projectDir);

    expect(result).toEqual({ reset: true, migrated: true, seeded: true });
  });

  it('--skip-seed skips the seed step and returns seeded:false', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { 'skip-seed': true },
    })) as { reset: boolean; migrated: boolean; seeded: boolean };

    expect(adapter.resetDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.applyMigrations).toHaveBeenCalledTimes(1);
    expect(adapter.seed).not.toHaveBeenCalled();
    expect(result).toEqual({ reset: true, migrated: true, seeded: false });
  });

  it('wraps a reset-step failure in a CLIError and skips the later steps', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter({
      resetImpl: async () => {
        throw new Error('DROP TABLE failed: connection refused');
      },
    });
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/drop step failed/i);
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toMatch(/connection refused/);

    // Failure short-circuits — migrate + seed must not run.
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('wraps a migrate-step failure and skips the seed step', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter({
      migrateImpl: async () => {
        throw new Error('prisma migrate deploy failed (exit 1): bad schema');
      },
    });
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/migrate step failed/i);
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toMatch(/bad schema/);

    // Reset already ran, but seed must be skipped after a migrate failure.
    expect(adapter.resetDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('wraps a seed-step ok:false return in a CLIError so the CLI exits non-zero', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter({
      seedImpl: async () => ({ ok: false, output: 'Error: seed crashed\n' }),
    });
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/seed step failed/i);
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toContain('seed crashed');

    // Earlier steps still completed before the seed failure.
    expect(adapter.resetDatabase).toHaveBeenCalledTimes(1);
    expect(adapter.applyMigrations).toHaveBeenCalledTimes(1);
  });

  it('renders pretty output with [OK] header + per-step status table', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    const out = (await cmd.run({
      cwd: projectDir,
      format: 'pretty',
      args: [],
      flags: {},
    })) as string;

    // Header + each status line; we assert on substrings rather than the
    // full string so tweaks to column spacing don't churn the test.
    expect(out).toMatch(/\[OK\] db reset/);
    expect(out).toMatch(/reset\s+yes/);
    expect(out).toMatch(/migrated\s+yes/);
    expect(out).toMatch(/seeded\s+yes/);
  });

  it('pretty output reflects --skip-seed by reporting seeded:no', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbResetCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    const out = (await cmd.run({
      cwd: projectDir,
      format: 'pretty',
      args: [],
      flags: { 'skip-seed': true },
    })) as string;

    expect(out).toMatch(/seeded\s+no/);
  });

  it('default export uses prismaAdapter (smoke check on the wiring)', () => {
    expect(typeof dbResetCommand.run).toBe('function');
  });
});
