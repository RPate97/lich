import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import {
  CLIError,
  type ORMAdapter,
  type ORMContext,
  type MigrationResult,
  type MigrationFile,
  type SchemaDescription,
  type TableDescription,
  type ColumnDescription,
  type TableRow,
} from '@lich/core';

/**
 * Error thrown when a prisma CLI invocation exits non-zero.
 *
 * LEV-197 — instead of synthesizing a single-line `Error('... failed:
 * <stderr>')` (which loses the structured exit code, command line, and
 * separate stdout/stderr buffers behind a flat string), the adapter throws
 * a {@link CLIError} carrying both the structured payload (consumed by the
 * pretty renderer's `details:` block) and a human-readable summary. Higher
 * layers (the generator, the `db.*` commands) catch this and forward
 * either the message or the whole thing via `CLIError.cause`.
 */
function makeChildFailureError(opts: {
  subcommand: string;
  command: string;
  args: string[];
  stderr: string;
  stdout: string;
  exitCode: number;
}): CLIError {
  // Prefer stderr for the inline message; fall back to stdout for prisma
  // subcommands that route their human-readable errors to stdout (rare,
  // but happens with `prisma db seed`'s spawned process). Truncate to
  // ~4 KiB so a multi-megabyte error log can't blow the message line.
  const blob = (opts.stderr.trim() || opts.stdout.trim()).slice(0, 4096);
  return new CLIError(
    'INTERNAL',
    `prisma ${opts.subcommand} failed (exit ${opts.exitCode})${blob ? `: ${blob}` : ''}`,
    {
      details: {
        command: `${opts.command} ${opts.args.join(' ')}`,
        exitCode: opts.exitCode,
        stderr: opts.stderr,
        stdout: opts.stdout,
      },
    },
  );
}

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
 * Force `localhost` to resolve to IPv4. Lich binds postgres to
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

/**
 * Map a datasource URL protocol to a Prisma-style driver name.
 *
 * The URL is the canonical source of truth — `plugin-postgres` publishes
 * `'postgresql'` via `addEnvSource('driver')`, but the adapter's view of the
 * active datasource is always whatever URL was passed in `ctx.databaseUrl`,
 * so we derive the driver from that to avoid plumbing extra wiring through
 * `ORMContext`. Returns the driver string (`'postgresql' | 'mysql' | ...`)
 * or the raw protocol (without trailing colon) when we don't recognize it —
 * callers throw an actionable "unsupported driver" error in that case.
 */
function deriveDriver(databaseUrl: string): string {
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    // SQLite Prisma URLs (`file:./dev.db`) are not valid WHATWG URLs because
    // they're relative — fall back to a string check.
    if (databaseUrl.startsWith('file:')) return 'sqlite';
    return 'unknown';
  }
  // Strip the trailing colon (`postgres:` → `postgres`).
  const scheme = protocol.replace(/:$/, '');
  switch (scheme) {
    case 'postgres':
    case 'postgresql':
      return 'postgresql';
    case 'mysql':
      return 'mysql';
    case 'file':
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
    case 'mongodb+srv':
      return 'mongodb';
    case 'sqlserver':
      return 'sqlserver';
    default:
      return scheme;
  }
}

/**
 * Postgres-specific "reset to empty" — drops every user table in the public
 * schema (including the `_prisma_migrations` bookkeeping table) so the next
 * `applyMigrations` starts from scratch.
 *
 * We enumerate tables and drop them one-by-one rather than nuking the schema
 * wholesale because the latter is a postgres-specific concept that doesn't
 * round-trip to MySQL/SQLite/etc. — keeping the teardown at the table grain
 * makes the analogue for those drivers (when we add them) straightforward.
 *
 * Internal helper. Driver-specific code is allowed here (this function is
 * never exported); it's the dispatch inside `resetDatabase` that keeps the
 * adapter's public surface driver-agnostic.
 */
async function resetPostgres(ctx: ORMContext): Promise<void> {
  await withPgClient(ctx.databaseUrl, async (client) => {
    const res = await client.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename
         FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    if (res.rows.length === 0) return;
    // Build one statement with all tables CASCADE — atomic, and order doesn't
    // matter because CASCADE walks FK dependencies for us.
    const list = res.rows
      .map((r) => `"${r.schemaname.replace(/"/g, '""')}"."${r.tablename.replace(/"/g, '""')}"`)
      .join(', ');
    await client.query(`DROP TABLE IF EXISTS ${list} CASCADE`);
  });
}

export const prismaAdapter: ORMAdapter = {
  name: 'prisma',

  async applyMigrations(ctx: ORMContext): Promise<MigrationResult> {
    const args = ['migrate', 'deploy', '--schema', schemaPath(ctx.projectRoot)];
    const r = await runChild(
      process.execPath,
      [prismaBinPath(), ...args],
      { cwd: ctx.projectRoot, databaseUrl: ctx.databaseUrl, timeoutMs: 120_000 },
    );
    const output = r.stdout + r.stderr;
    if (r.exitCode !== 0) {
      // LEV-197 — structured CLIError preserves the separate stderr/stdout
      // streams and exit code for the renderer's `details:` block instead
      // of flattening them into the message string.
      throw makeChildFailureError({
        subcommand: 'migrate deploy',
        command: 'prisma',
        args,
        stderr: r.stderr,
        stdout: r.stdout,
        exitCode: r.exitCode,
      });
    }
    const { applied, names } = parseApplied(r.stdout);
    return { applied, names, output };
  },

  async newMigration(ctx: ORMContext, name: string): Promise<MigrationFile> {
    // LEV-215: Prisma 7 rejects `--skip-generate` with "unknown or unexpected
    // option" — the flag was dropped because prisma now always regenerates the
    // client as part of `migrate dev`. The cost is an extra regen step we
    // didn't want (we already expose `generateClient` separately for callers
    // that need explicit control); the alternative is silencing the regen with
    // env-var gymnastics, which is more work for a marginal speedup.
    const args = [
      'migrate',
      'dev',
      '--create-only',
      '--name',
      name,
      '--schema',
      schemaPath(ctx.projectRoot),
    ];
    const r = await runChild(process.execPath, [prismaBinPath(), ...args], {
      cwd: ctx.projectRoot,
      databaseUrl: ctx.databaseUrl,
      timeoutMs: 120_000,
    });
    if (r.exitCode !== 0) {
      throw makeChildFailureError({
        subcommand: 'migrate dev --create-only',
        command: 'prisma',
        args,
        stderr: r.stderr,
        stdout: r.stdout,
        exitCode: r.exitCode,
      });
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
    // "Reset to empty" primitive: leaves the database with no user tables so
    // the next `applyMigrations` starts from scratch. We can't use
    // `prisma migrate reset --force` (re-applies migrations) or
    // `prisma db push --force-reset` (pushes the schema back in) — both put
    // tables back, which is the opposite of what callers expect.
    //
    // Instead, dispatch on the active datasource's driver and let the
    // driver-specific helper do the teardown. The dispatch table here is the
    // ORM's responsibility (composability principle, plan-14): callers see
    // `orm.resetDatabase(ctx)` and never touch driver-specific code.
    const driver = deriveDriver(ctx.databaseUrl);
    switch (driver) {
      case 'postgresql':
        return resetPostgres(ctx);
      default:
        throw new Error(
          `prismaAdapter.resetDatabase: unsupported driver "${driver}" ` +
            `(derived from datasource URL). Add a driver-specific helper to ` +
            `packages/plugin-prisma/src/adapter.ts to extend support.`,
        );
    }
  },

  async generateClient(ctx: ORMContext): Promise<void> {
    const args = ['generate', '--schema', schemaPath(ctx.projectRoot)];
    const r = await runChild(
      process.execPath,
      [prismaBinPath(), ...args],
      { cwd: ctx.projectRoot, databaseUrl: ctx.databaseUrl, timeoutMs: 120_000 },
    );
    if (r.exitCode !== 0) {
      throw makeChildFailureError({
        subcommand: 'generate',
        command: 'prisma',
        args,
        stderr: r.stderr,
        stdout: r.stdout,
        exitCode: r.exitCode,
      });
    }
  },

  /**
   * Hand out a `PrismaClient` instance bound to `ctx.databaseUrl`.
   *
   * Used by composable consumers (LEV-173 — `plugin-better-auth` passes
   * this client to `@better-auth/prisma-adapter` so auth writes land in
   * the project's actual database instead of a separate sqlite file).
   *
   * LEV-215: Prisma 7 removed the `datasourceUrl` option in favor of the
   * driver-adapter pattern. For postgres the connection string flows
   * through `new PrismaPg({ connectionString })` from
   * `@prisma/adapter-pg`, which the `PrismaClient` consumes via
   * `{ adapter }`. This matches what the LEV-196 template's
   * `apps/api/src/prisma.ts` does for its long-lived client.
   *
   * `@prisma/client` and `@prisma/adapter-pg` are imported lazily: the
   * generated client lives in the *consumer's* `node_modules` (wherever
   * they ran `prisma generate`), and we don't want `getClient` to crash
   * the rest of the adapter when prisma isn't installed. The lazy
   * require + try/catch surfaces actionable install hints instead.
   */
  async getClient(ctx: ORMContext): Promise<unknown> {
    type PrismaClientCtor = new (opts: { adapter: unknown }) => unknown;
    type PrismaPgCtor = new (opts: { connectionString: string }) => unknown;

    let PrismaClient: PrismaClientCtor;
    try {
      // Use createRequire so we resolve against the consumer's node_modules
      // tree, not ours — the generated client lives wherever the user ran
      // `prisma generate`. The lazy import keeps this off the cold path.
      const mod = localRequire('@prisma/client') as {
        PrismaClient: PrismaClientCtor;
      };
      PrismaClient = mod.PrismaClient;
    } catch (err) {
      throw new Error(
        `prismaAdapter.getClient: failed to load @prisma/client. ` +
          `Install it as a dependency in your project and run \`prisma generate\`. ` +
          `(${(err as Error).message})`,
        { cause: err },
      );
    }

    let PrismaPg: PrismaPgCtor;
    try {
      const mod = localRequire('@prisma/adapter-pg') as {
        PrismaPg: PrismaPgCtor;
      };
      PrismaPg = mod.PrismaPg;
    } catch (err) {
      throw new Error(
        `prismaAdapter.getClient: failed to load @prisma/adapter-pg. ` +
          `Prisma 7 requires the driver-adapter pattern — install ` +
          `\`@prisma/adapter-pg\` as a dependency in your project. ` +
          `(${(err as Error).message})`,
        { cause: err },
      );
    }

    const connectionString = normalizeDatabaseUrlForPg(ctx.databaseUrl);
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  },
};
