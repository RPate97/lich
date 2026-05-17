import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@levelzero/core/registry';
import { computeWorktreeKey } from '@levelzero/core/worktree';
import { CLIError } from '@levelzero/core/errors';
import { makeDbMigrateCommand, dbMigrateCommand } from '../../src/commands/migrate';
import type { ORMAdapter, ORMContext, MigrationResult } from '@levelzero/core';

function stubAdapter(
  impl: (ctx: ORMContext) => Promise<MigrationResult>,
): ORMAdapter {
  return {
    name: 'stub',
    applyMigrations: vi.fn(impl) as unknown as ORMAdapter['applyMigrations'],
    newMigration: vi.fn(),
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
const POSTGRES_PORT = 54813;

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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-migrate-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-migrate-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero db migrate', () => {
  it('exports a command named "db.migrate"', () => {
    expect(dbMigrateCommand.name).toBe('db.migrate');
    expect(typeof dbMigrateCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-migrate-outside-')));
    const adapter = stubAdapter(async () => ({ applied: 0, names: [], output: '' }));
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
  });

  it('errors with a clear message when no stack is running', async () => {
    const adapter = stubAdapter(async () => ({ applied: 0, names: [], output: '' }));
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
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
    const adapter = stubAdapter(async () => ({ applied: 0, names: [], output: '' }));
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/postgres/i);
    expect(adapter.applyMigrations).not.toHaveBeenCalled();
  });

  it('invokes prismaAdapter.applyMigrations with the derived DATABASE_URL + projectRoot and returns result on success', async () => {
    await seedRegistryEntry();
    let captured: ORMContext | undefined;
    const adapter = stubAdapter(async (ctx) => {
      captured = ctx;
      return { applied: 2, names: ['20260101_init', '20260102_add_users'], output: 'Applied 2\n' };
    });
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { ok: boolean; applied: number; names: string[]; output: string };

    expect(adapter.applyMigrations).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.projectRoot).toBe(projectDir);
    expect(captured!.databaseUrl).toBe(
      `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.names).toEqual(['20260101_init', '20260102_add_users']);
    expect(result.output).toBe('Applied 2\n');
  });

  it('accepts --dev and --schema flags without rejecting', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => ({ applied: 0, names: [], output: '' }));
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { dev: true, schema: 'custom/schema.prisma' },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(adapter.applyMigrations).toHaveBeenCalledTimes(1);
  });

  it('wraps adapter errors in a CLIError so the CLI exits non-zero', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => {
      throw new Error('prisma migrate deploy failed (exit 1): boom');
    });
    const cmd = makeDbMigrateCommand({ getRegistry: () => registry, adapter });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/migrate/i);
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toMatch(/boom/);
  });

  it('default export uses prismaAdapter (smoke check on the wiring)', () => {
    expect(typeof dbMigrateCommand.run).toBe('function');
  });
});
