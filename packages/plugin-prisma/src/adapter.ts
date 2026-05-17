import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import type {
  ORMAdapter,
  ORMContext,
  MigrationResult,
  MigrationFile,
  SchemaDescription,
  TableDescription,
  ColumnDescription,
  TableRow,
} from '@levelzero/core';

/**
 * Resolve the local prisma CLI entry point. We resolve via require so the same
 * code works whether this package is consumed from the monorepo or installed
 * elsewhere — we always want *our* pinned prisma version, never whatever `npx`
 * decides to fetch (which can be a much newer major if the latest tag moved).
 */
const localRequire = createRequire(import.meta.url);
function prismaBinPath(): string {
  const pkgJsonPath = localRequire.resolve('prisma/package.json');
  return join(dirname(pkgJsonPath), 'build', 'index.js');
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a child process, streaming stdout/stderr into buffers. We use spawn (not
 * exec) so large outputs (Prisma migration log) won't blow the exec buffer.
 * DATABASE_URL is injected explicitly on every call so Prisma's schema
 * `env("DATABASE_URL")` directive resolves without needing a .env file.
 */
function runChild(
  cmd: string,
  args: string[],
  opts: { cwd: string; databaseUrl: string; timeoutMs?: number },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, DATABASE_URL: normalizeDatabaseUrlForPg(opts.databaseUrl) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(' ')}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function schemaPath(projectRoot: string): string {
  return join(projectRoot, 'prisma', 'schema.prisma');
}

/**
 * Parse Prisma migrate-deploy stdout to count applied migrations.
 *
 * Format we look for:
 *   - "Applying migration `<name>`"     (one line per applied migration)
 *   - "No pending migrations to apply." (everything already applied)
 *
 * The CLI's output format is stable across 4.x/5.x; we fall back to 0 + empty
 * names rather than throw if neither pattern matches, since the exit code
 * already signals success.
 */
function parseApplied(stdout: string): { applied: number; names: string[] } {
  const names: string[] = [];
  const re = /Applying migration `([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stdout)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return { applied: names.length, names };
}

async function findNewestMigrationDir(projectRoot: string, name: string): Promise<string> {
  const migrationsDir = join(projectRoot, 'prisma', 'migrations');
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch {
    throw new Error(`migrations directory not found at ${migrationsDir}`);
  }
  // Prisma names dirs `<timestamp>_<name>` — find the newest one ending in our suggested name.
  const matching = entries
    .filter((e) => e.endsWith(`_${name}`))
    .sort()
    .reverse();
  if (matching.length === 0 || !matching[0]) {
    throw new Error(`could not locate newly-created migration directory for "${name}" in ${migrationsDir}`);
  }
  return join(migrationsDir, matching[0]);
}

/**
 * Force `localhost` to resolve to IPv4. Levelzero binds postgres to
 * `127.0.0.1:<port>` in `docker run`, but Node's default DNS prefers IPv6,
 * which causes `ECONNREFUSED ::1:<port>` on macOS / Linux dual-stack setups.
 * We rewrite the URL before handing it to `pg` to sidestep that.
 */
function normalizeDatabaseUrlForPg(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString();
  } catch {
    return url;
  }
}

async function withPgClient<T>(databaseUrl: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: normalizeDatabaseUrlForPg(databaseUrl) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const prismaAdapter: ORMAdapter = {
  name: 'prisma',

  async applyMigrations(ctx: ORMContext): Promise<MigrationResult> {
    const r = await runChild(
      process.execPath,
      [prismaBinPath(), 'migrate', 'deploy', '--schema', schemaPath(ctx.projectRoot)],
      { cwd: ctx.projectRoot, databaseUrl: ctx.databaseUrl, timeoutMs: 120_000 },
    );
    const output = r.stdout + r.stderr;
    if (r.exitCode !== 0) {
      throw new Error(`prisma migrate deploy failed (exit ${r.exitCode}): ${output.trim()}`);
    }
    const { applied, names } = parseApplied(r.stdout);
    return { applied, names, output };
  },

  async newMigration(ctx: ORMContext, name: string): Promise<MigrationFile> {
    const r = await runChild(
      process.execPath,
      [
        prismaBinPath(),
        'migrate',
        'dev',
        '--create-only',
        '--skip-generate',
        '--name',
        name,
        '--schema',
        schemaPath(ctx.projectRoot),
      ],
      { cwd: ctx.projectRoot, databaseUrl: ctx.databaseUrl, timeoutMs: 120_000 },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `prisma migrate dev --create-only failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`,
      );
    }
    const dir = await findNewestMigrationDir(ctx.projectRoot, name);
    return { path: dir, name };
  },

  async seed(ctx: ORMContext): Promise<{ ok: boolean; output: string }> {
    const r = await runChild(process.execPath, [prismaBinPath(), 'db', 'seed'], {
      cwd: ctx.projectRoot,
      databaseUrl: ctx.databaseUrl,
      timeoutMs: 120_000,
    });
    const output = r.stdout + r.stderr;
    return { ok: r.exitCode === 0, output };
  },

  async inspectSchema(ctx: ORMContext): Promise<SchemaDescription> {
    return withPgClient(ctx.databaseUrl, async (client) => {
      const tablesRes = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name
           FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name`,
      );

      const tables: Record<string, TableDescription> = {};
      for (const t of tablesRes.rows) {
        const colsRes = await client.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [t.table_schema, t.table_name],
        );
        const columns: ColumnDescription[] = colsRes.rows.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          ...(c.column_default !== null ? { defaultExpr: c.column_default } : {}),
        }));
        // Skip the prisma migrations bookkeeping table to keep results focused on user schema.
        if (t.table_name === '_prisma_migrations') continue;
        tables[t.table_name] = { columns };
      }
      return { tables };
    });
  },

  async inspectTable(ctx: ORMContext, name: string, limit?: number): Promise<TableRow[]> {
    const safeLimit = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : 100;
    // Identifier quoting: wrap the table name in "..." and escape any embedded quotes.
    // This is safe enough for our internal callers; we never accept this from end users
    // directly without further validation.
    const quoted = `"${name.replace(/"/g, '""')}"`;
    return withPgClient(ctx.databaseUrl, async (client) => {
      const res = await client.query(`SELECT * FROM ${quoted} LIMIT ${safeLimit}`);
      return res.rows as TableRow[];
    });
  },

  async resetDatabase(ctx: ORMContext): Promise<void> {
    // Drop and recreate the public schema. This is equivalent to
    // `prisma migrate reset --force` minus the re-apply step: it leaves the
    // database empty so the next `applyMigrations` starts from scratch.
    // We do this with pg directly rather than shelling out to prisma because
    // `prisma db push --force-reset` would push the schema back in, leaving
    // tables present — which is the opposite of what callers expect from a
    // "reset to empty" primitive.
    await withPgClient(ctx.databaseUrl, async (client) => {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
    });
  },

  async generateClient(ctx: ORMContext): Promise<void> {
    const r = await runChild(
      process.execPath,
      [prismaBinPath(), 'generate', '--schema', schemaPath(ctx.projectRoot)],
      { cwd: ctx.projectRoot, databaseUrl: ctx.databaseUrl, timeoutMs: 120_000 },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `prisma generate failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`,
      );
    }
  },
};
