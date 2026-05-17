import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@levelzero/core/registry';
import { computeWorktreeKey } from '@levelzero/core/worktree';
import { CLIError } from '@levelzero/core/errors';
import { makeDbSeedCommand, dbSeedCommand } from '../../src/commands/seed';
import type { ORMAdapter, ORMContext } from '@levelzero/core';

function stubAdapter(
  impl: (ctx: ORMContext) => Promise<{ ok: boolean; output: string }>,
): ORMAdapter {
  return {
    name: 'stub',
    applyMigrations: vi.fn(),
    newMigration: vi.fn(),
    seed: vi.fn(impl) as unknown as ORMAdapter['seed'],
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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-seed-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-seed-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero db seed', () => {
  it('exports a command named "db.seed"', () => {
    expect(dbSeedCommand.name).toBe('db.seed');
    expect(typeof dbSeedCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-seed-outside-')));
    const adapter = stubAdapter(async () => ({ ok: true, output: '' }));
    const cmd = makeDbSeedCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('errors with a clear message when no stack is running', async () => {
    const adapter = stubAdapter(async () => ({ ok: true, output: '' }));
    const cmd = makeDbSeedCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.seed).not.toHaveBeenCalled();
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
    const adapter = stubAdapter(async () => ({ ok: true, output: '' }));
    const cmd = makeDbSeedCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(/postgres/i);
    expect(adapter.seed).not.toHaveBeenCalled();
  });

  it('invokes prismaAdapter.seed with the derived DATABASE_URL + projectRoot and returns ok on success', async () => {
    await seedRegistryEntry();
    let captured: ORMContext | undefined;
    const adapter = stubAdapter(async (ctx) => {
      captured = ctx;
      return { ok: true, output: 'Seeded 3 rows\n' };
    });
    const cmd = makeDbSeedCommand({ getRegistry: () => registry, adapter });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { ok: boolean; output: string };

    expect(adapter.seed).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.projectRoot).toBe(projectDir);
    expect(captured!.databaseUrl).toBe(
      `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe('Seeded 3 rows\n');
  });

  it('throws a CLIError when the adapter returns ok=false so the CLI exits non-zero', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter(async () => ({
      ok: false,
      output: 'Error: seed script crashed\n',
    }));
    const cmd = makeDbSeedCommand({ getRegistry: () => registry, adapter });

    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/seed/i);
    // adapter output surfaced in details so callers can see what went wrong
    const details = (err as CLIError).details as { output?: string } | undefined;
    expect(details?.output).toContain('seed script crashed');
  });

  it('default export uses prismaAdapter (smoke check on the wiring)', () => {
    // dbSeedCommand is the factory default; ensure it doesn't throw at construction
    // and exposes the right shape.
    expect(typeof dbSeedCommand.run).toBe('function');
  });
});
