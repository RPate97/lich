import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ORMAdapter,
  MigrationResult,
  MigrationFile,
  SchemaDescription,
  TableRow,
  ORMContext,
} from '../../../src/adapters/orm/types';

describe('ORMAdapter types', () => {
  it('ORMContext carries connection details', () => {
    const ctx: ORMContext = {
      databaseUrl: 'postgres://...',
      projectRoot: '/abs/path',
    };
    expect(ctx.databaseUrl).toContain('postgres://');
  });

  it('ORMAdapter has the expected method shape', () => {
    expectTypeOf<ORMAdapter>().toMatchTypeOf<{
      name: string;
      applyMigrations(ctx: ORMContext): Promise<MigrationResult>;
      newMigration(ctx: ORMContext, name: string): Promise<MigrationFile>;
      seed(ctx: ORMContext): Promise<{ ok: boolean; output: string }>;
      inspectSchema(ctx: ORMContext): Promise<SchemaDescription>;
      inspectTable(ctx: ORMContext, name: string, limit?: number): Promise<TableRow[]>;
      resetDatabase(ctx: ORMContext): Promise<void>;
      generateClient(ctx: ORMContext): Promise<void>;
    }>();
  });

  it('MigrationResult includes applied count + names', () => {
    const r: MigrationResult = { applied: 2, names: ['init', 'add_users'], output: '' };
    expect(r.applied).toBe(2);
  });

  it('MigrationFile points at a generated file', () => {
    const f: MigrationFile = { path: '/abs/prisma/migrations/...', name: 'add_users' };
    expect(f.name).toBe('add_users');
  });

  it('SchemaDescription is a table->columns map', () => {
    const s: SchemaDescription = {
      tables: {
        users: { columns: [{ name: 'id', type: 'uuid', nullable: false }] },
      },
    };
    expect(s.tables.users!.columns[0]!.name).toBe('id');
  });

  it('TableRow is an arbitrary JSON record', () => {
    const r: TableRow = { id: 'abc', email: 'a@b.com' };
    expect(r.id).toBe('abc');
  });
});
