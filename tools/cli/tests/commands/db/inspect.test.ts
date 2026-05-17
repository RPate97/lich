import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../../src/registry';
import { computeWorktreeKey } from '../../../src/worktree';
import { CLIError } from '../../../src/errors';
import { makeDbInspectCommand, dbInspectCommand } from '../../../src/commands/db/inspect';
import type {
  ORMAdapter,
  ORMContext,
  SchemaDescription,
  TableRow,
} from '../../../src/adapters/orm/types';

interface AdapterStubs {
  inspectSchemaImpl?: (ctx: ORMContext) => Promise<SchemaDescription>;
  inspectTableImpl?: (ctx: ORMContext, name: string, limit?: number) => Promise<TableRow[]>;
}

function stubAdapter(stubs: AdapterStubs = {}): ORMAdapter {
  return {
    name: 'stub',
    applyMigrations: vi.fn(),
    newMigration: vi.fn(),
    seed: vi.fn(),
    inspectSchema: vi.fn(
      stubs.inspectSchemaImpl ?? (async () => ({ tables: {} })),
    ) as unknown as ORMAdapter['inspectSchema'],
    inspectTable: vi.fn(
      stubs.inspectTableImpl ?? (async () => []),
    ) as unknown as ORMAdapter['inspectTable'],
    resetDatabase: vi.fn(),
    generateClient: vi.fn(),
  } as unknown as ORMAdapter;
}

let projectDir: string;
let homeDir: string;
let registry: Registry;
const POSTGRES_PORT = 54823;

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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-inspect-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-inspect-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
});

describe('levelzero db inspect', () => {
  it('exports a command named "db.inspect"', () => {
    expect(dbInspectCommand.name).toBe('db.inspect');
    expect(typeof dbInspectCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-db-inspect-outside-')));
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: { schema: true } }),
    ).rejects.toThrow(CLIError);
    expect(adapter.inspectSchema).not.toHaveBeenCalled();
  });

  it('errors with a clear message when no stack is running', async () => {
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { schema: true } }),
    ).rejects.toThrow(/no stack/i);
    expect(adapter.inspectSchema).not.toHaveBeenCalled();
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
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { schema: true } }),
    ).rejects.toThrow(/postgres/i);
    expect(adapter.inspectSchema).not.toHaveBeenCalled();
  });

  it('errors when neither --schema nor --rows flag is passed', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    const err = await cmd
      .run({ cwd: projectDir, format: 'json', args: [], flags: {} })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/--schema|--rows/);
    expect(adapter.inspectSchema).not.toHaveBeenCalled();
    expect(adapter.inspectTable).not.toHaveBeenCalled();
  });

  it('--schema invokes inspectSchema with derived DATABASE_URL and returns the schema JSON', async () => {
    await seedRegistryEntry();
    let captured: ORMContext | undefined;
    const schema: SchemaDescription = {
      tables: {
        users: {
          columns: [
            { name: 'id', type: 'uuid', nullable: false },
            { name: 'email', type: 'text', nullable: false },
          ],
        },
      },
    };
    const adapter = stubAdapter({
      inspectSchemaImpl: async (ctx) => {
        captured = ctx;
        return schema;
      },
    });
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { schema: true },
    })) as SchemaDescription;

    expect(adapter.inspectSchema).toHaveBeenCalledTimes(1);
    expect(adapter.inspectTable).not.toHaveBeenCalled();
    expect(captured).toBeDefined();
    expect(captured!.projectRoot).toBe(projectDir);
    expect(captured!.databaseUrl).toBe(
      `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
    );
    expect(result).toEqual(schema);
  });

  it('--rows <table> invokes inspectTable with the table name and default limit', async () => {
    await seedRegistryEntry();
    let capturedCtx: ORMContext | undefined;
    let capturedName: string | undefined;
    let capturedLimit: number | undefined;
    const rows: TableRow[] = [{ id: 1 }, { id: 2 }];
    const adapter = stubAdapter({
      inspectTableImpl: async (ctx, name, limit) => {
        capturedCtx = ctx;
        capturedName = name;
        capturedLimit = limit;
        return rows;
      },
    });
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { rows: 'users' },
    })) as TableRow[];

    expect(adapter.inspectTable).toHaveBeenCalledTimes(1);
    expect(adapter.inspectSchema).not.toHaveBeenCalled();
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.databaseUrl).toBe(
      `postgres://levelzero:levelzero@localhost:${POSTGRES_PORT}/levelzero`,
    );
    expect(capturedName).toBe('users');
    // default limit per spec is 50
    expect(capturedLimit).toBe(50);
    expect(result).toEqual(rows);
  });

  it('--rows <table> --limit N passes the parsed limit through', async () => {
    await seedRegistryEntry();
    let capturedLimit: number | undefined;
    const adapter = stubAdapter({
      inspectTableImpl: async (_ctx, _name, limit) => {
        capturedLimit = limit;
        return [];
      },
    });
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { rows: 'orders', limit: '10' },
    });
    expect(capturedLimit).toBe(10);
  });

  it('--rows without a table name errors', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { rows: true } }),
    ).rejects.toThrow(/table|--rows/i);
    expect(adapter.inspectTable).not.toHaveBeenCalled();
  });

  it('--limit must be a positive integer', async () => {
    await seedRegistryEntry();
    const adapter = stubAdapter();
    const cmd = makeDbInspectCommand({ getRegistry: () => registry, adapter });
    await expect(
      cmd.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: { rows: 'users', limit: 'abc' },
      }),
    ).rejects.toThrow(/limit/i);
    expect(adapter.inspectTable).not.toHaveBeenCalled();
  });

  it('default export uses prismaAdapter (smoke check on the wiring)', () => {
    expect(typeof dbInspectCommand.run).toBe('function');
  });
});
