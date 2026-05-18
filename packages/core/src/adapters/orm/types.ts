/**
 * ORMAdapter — pluggable interface for the ORM slot.
 *
 * Hypothetical alternative implementations:
 *   - Prisma   (current default; ships in `@levelzero/plugin-prisma`)
 *   - Drizzle  (`drizzle-orm` + `drizzle-kit`)
 *   - Kysely   (raw query builder + codegen)
 *   - Mongoose (NoSQL via MongoDB)
 *   - TypeORM  (legacy but still in the wild)
 *
 * Any impl in this slot MUST dispatch internally on the active
 * `DatabaseProvider`'s driver (`postgres`, `mysql`, `sqlite`, `mongo`, …) —
 * driver-specific code (DROP SCHEMA, file-based teardown, drop-database
 * commands) stays inside the impl, never in this interface.
 *
 * Consumer-POV check: every method here describes WHAT the caller wants
 * (apply migrations, reset, inspect a table) — not HOW any specific ORM
 * achieves it. If you find yourself adding a field named after a tool
 * (`prismaSchemaPath`, `drizzleConfig`, `mongooseModel`), you are leaking
 * the implementation through the contract; push it back inside the impl.
 *
 * TODO(LEV-176/follow-up): `inspectSchema`/`inspectTable` return SQL-shaped
 * descriptions (`tables`/`columns`). For document-store ORMs (Mongoose,
 * future Dynamo, etc.) the natural shape is "collections / sample document".
 * If/when we add a non-SQL ORM impl, generalize `SchemaDescription` to a
 * tagged union (`{ kind: 'relational' | 'document'; ... }`) rather than the
 * current SQL-only shape.
 */

export interface ORMContext {
  databaseUrl: string;
  projectRoot: string;
}

export interface MigrationResult {
  applied: number;
  names: string[];
  output: string;
}

export interface MigrationFile {
  path: string;
  name: string;
}

export interface ColumnDescription {
  name: string;
  type: string;
  nullable: boolean;
  defaultExpr?: string;
}

export interface TableDescription {
  columns: ColumnDescription[];
}

export interface SchemaDescription {
  tables: Record<string, TableDescription>;
}

export type TableRow = Record<string, unknown>;

export interface ORMAdapter {
  name: string;
  applyMigrations(ctx: ORMContext): Promise<MigrationResult>;
  newMigration(ctx: ORMContext, name: string): Promise<MigrationFile>;
  seed(ctx: ORMContext): Promise<{ ok: boolean; output: string }>;
  inspectSchema(ctx: ORMContext): Promise<SchemaDescription>;
  inspectTable(ctx: ORMContext, name: string, limit?: number): Promise<TableRow[]>;
  resetDatabase(ctx: ORMContext): Promise<void>;
  generateClient(ctx: ORMContext): Promise<void>;
  /**
   * Escape hatch: return the underlying ORM-native client for callers that
   * need to pass it to a peer library's adapter. For Prisma this is a
   * `PrismaClient` instance, for Drizzle a `db` handle, for Mongoose the
   * active `Connection`, etc.
   *
   * The return type is `unknown` on purpose: ORM clients have no common
   * supertype, and consumers (auth plugins, custom commands) already dispatch
   * on `adapter.name` to pick the right downstream adapter shape (e.g.
   * `@better-auth/prisma-adapter` vs `@better-auth/drizzle-adapter`). Typing
   * this any narrower would just push the cast back onto every consumer.
   *
   * Optional because not every ORM impl will support direct client access —
   * notably, a future "raw SQL" impl in this slot has no client to hand out.
   * Consumers MUST check for `undefined` and fall back accordingly (typically
   * an actionable error pointing at the missing capability).
   *
   * Introduced for LEV-173 so `plugin-better-auth` can consume the active
   * ORM instead of hardcoding `better-sqlite3`. See the auth-slot docstring
   * in `../auth/types.ts` for the consumer-side contract.
   */
  getClient?(ctx: ORMContext): Promise<unknown> | unknown;
}
