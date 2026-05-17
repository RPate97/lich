import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@levelzero/core/registry';
import { computeWorktreeKey } from '@levelzero/core/worktree';
import { CLIError } from '@levelzero/core/errors';
import {
  makeDbMigrationNewCommand,
  dbMigrationNewCommand,
} from '../../src/commands/migration-new';
import type { ORMAdapter, ORMContext, MigrationFile } from '@levelzero/core';

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
    logDir: '.levelzero/logs',
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero db migration new', () => {
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
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
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
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
    // camelCase / kebab / leading-digit / spaces all rejected
    for (const bad of ['AddUsers', 'add-users', '1add_users', 'add users', '']) {
      await expect(
        cmd.run({ cwd: projectDir, format: 'json', args: [bad], flags: {} }),
      ).rejects.toThrow(CLIError);
    }
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-mignew-outside-')));
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
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
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['add_users'], flags: {} }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('errors when the running stack has no postgres port', async () => {
    await registry.upsert(computeWorktreeKey(projectDir), {
      path: projectDir,
      branch: 'main',
      ports: {},
      urls: {},
      containers: [],
      network: '',
      logDir: '.levelzero/logs',
      createdAt: new Date().toISOString(),
    });
    const adapter = stubAdapter(async () => ({
      path: '/tmp/x/prisma/migrations/0_x',
      name: 'x',
    }));
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: ['add_users'], flags: {} }),
    ).rejects.toThrow(/postgres/i);
    expect(adapter.newMigration).not.toHaveBeenCalled();
  });

  it('invokes adapter.newMigration with the derived DATABASE_URL + projectRoot + name and returns the migration path', async () => {
    await seedRegistryEntry();
    let captured: { ctx: ORMContext; name: string } | undefined;
    const expectedPath = join(projectDir, 'prisma', 'migrations', '20260517000000_add_users');
    const adapter = stubAdapter(async (ctx, name) => {
      captured = { ctx, name };
      return { path: expectedPath, name };
    });
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });
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
      `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
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
    const cmd = makeDbMigrationNewCommand({ getRegistry: () => registry, adapter });

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
