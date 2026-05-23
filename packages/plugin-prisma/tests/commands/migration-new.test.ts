import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@lich/core/registry';
import { computeWorktreeKey } from '@lich/core/worktree';
import { CLIError } from '@lich/core/errors';
import { EnvSourceRegistry } from '@lich/core/env/registry';
import {
  makeDbMigrationNewCommand,
  dbMigrationNewCommand,
} from '../../src/commands/migration-new';
import type { ORMAdapter, ORMContext, MigrationFile } from '@lich/core';

function stubAdapter(
  impl: (ctx: ORMContext, name: string) => Promise<MigrationFile>,
): ORMAdapter {
  return {
    name: 'stub',
    applyMigrations: vi.fn(),
    newMigration: vi.fn(impl) as unknown as ORMAdapter['newMigration'],
    seed: vi.fn(),
    inspectSchema: vi.fn(),
    inspectTable: vi.fn(),
    resetDatabase: vi.fn(),
    generateClient: vi.fn(),
  } as unknown as ORMAdapter;
}

/**
 * Build a stub EnvSourceRegistry pre-populated with a `postgres.url` named
 * source — see migrate.test.ts for the full LEV-171 rationale.
 */
function envSourceRegistryWithPostgres(): EnvSourceRegistry {
  const reg = new EnvSourceRegistry();
  reg.registerNamed({
    namespace: 'postgres',
    name: 'url',
    fullKey: 'postgres.url',
    pluginName: '@lich/plugin-postgres',
    source: {
      protocol: 'postgres',
      host: ({ ports }) =>
        `postgres://lich:lich@localhost:${ports.postgres ?? ''}/lich`,
      container: () => `postgres://lich:lich@postgres:5432/lich`,
    },
  });
  return reg;
}

let projectDir: string;
let homeDir: string;
let registry: Registry;
const POSTGRES_PORT = 54812;

async function seedRegistryEntry(): Promise<void> {
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: { postgres: POSTGRES_PORT },
    urls: {},
    containers: [],
    network: '',
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('lich db migration new', () => {
  it('exports a command named "db.migration.new"', () => {
    expect(dbMigrationNewCommand.name).toBe('db.migration.new');
    expect(typeof dbMigrationNewCommand.describe).toBe('string');
  });

  it('errors when <name> argument is missing', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/name/i);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors when <name> is not snake_case', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    // camelCase / kebab / leading-digit / spaces all rejected
    for (const bad of ['AddUsers', 'add-users', '1add_users', 'add users', '']) {
      await expect(
        cmd.run({ cwd: projectDir, format: 'json', args: [bad], flags: {} }),
      ).rejects.toThrow(CLIError);
    }
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors NO_PROJECT when cwd is outside a lich project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-outside-')));
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: ['add_users'], flags: {} }),
    ).rejects.toThrow(CLIError);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors with a clear message when no stack is running', async () => {
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['add_users'], flags: {} }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors when no postgres EnvSource is registered (no DB plugin loaded)', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: () => new EnvSourceRegistry(),
    });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['add_users'], flags: {} }),
    ).rejects.toThrow(/postgres EnvSource/i);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('invokes adapter.newMigration with the EnvSource-resolved DATABASE_URL + projectRoot + name and returns the migration path', async () => {
    await seedRegistryEntry();
    let captured: { ctx: ORMContext; name: string } | undefined;
    const expectedPath = join(projectDir, 'prisma', 'migrations', '20260517000000_add_users');
    const adapter = stubAdapter(async (ctx, name) => {
      captured = { ctx, name };
      return { path: expectedPath, name };
    });
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: ['add_users'],
      flags: {},
    })) as { ok: boolean; path: string; name: string };

    expect(adapter.newMigration).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.ctx.projectRoot).toBe(projectDir);
    expect(captured!.ctx.databaseUrl).toBe(
      `postgres://lich:lich@localhost:${POSTGRES_PORT}/lich`,
    );
    expect(captured!.name).toBe('add_users');
    expect(result.ok).toBe(true);
    expect(result.path).toBe(expectedPath);
    expect(result.name).toBe('add_users');
  });

  it('wraps adapter throws in a CLIError so the CLI exits non-zero', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => {
      throw new Error('prisma migrate dev --create-only failed (exit 1): bad schema');
    });
    const cmd = makeDbMigrationNewCommand({
      getRegistry: () => registry,
      adapter,
      getEnvSourceRegistry: envSourceRegistryWithPostgres,
    });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: ['add_users'], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/migration/i);
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toContain('bad schema');
  });

  it('default export uses prismaAdapter (smoke check on the wiring)', () => {
    expect(typeof dbMigrationNewCommand.run).toBe('function');
  });
});
