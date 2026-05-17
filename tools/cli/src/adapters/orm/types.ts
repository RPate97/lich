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
}
