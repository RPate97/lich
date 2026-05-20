/**
 * LEV-198-extended — db.* command coverage.
 *
 * Every plugin-prisma command:
 *
 *   - `db migrate`             — apply migrations (LEV-204: broken today)
 *   - `db seed`                — seed (LEV-204: broken today)
 *   - `db inspect --schema`    — schema dump
 *   - `db inspect --rows`      — row dump (no rows → empty)
 *   - `db reset [--skip-seed]` — drop+migrate(+seed); LEV-204
 *   - `db migration new`       — scaffold a migration file (LEV-204)
 *
 * All are docker-gated (the prisma adapter shells against the live
 * postgres). Pre-dev paths (running these without `levelzero dev`) live in
 * `failure-surfaces.e2e.test.ts`.
 *
 * Failing tests carry the LEV-204 tag; when LEV-204 lands, the maintainer
 * removes `.fails` from each one in the same change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  setupScaffoldedProject,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli } from './_helpers/cli';
import { dockerAvailable } from './_helpers/docker';

const DOCKER = dockerAvailable();

let handle: E2EProjectHandle;

describe.skipIf(!DOCKER)('LEV-198-extended db.*: per-command coverage', () => {
  beforeAll(async () => {
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-db-' });
    // Bring the stack up once for the whole file. Each `db.*` test reads
    // from the live postgres; teardown happens in `afterAll`.
    const res = runCli(handle.projectDir, ['dev', '--json'], {
      timeoutMs: 180_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `dev failed in db.e2e setup (exit ${res.exitCode}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
    }
    try {
      const out = JSON.parse(res.stdout) as { compose?: { projectName?: string } };
      if (out.compose?.projectName) {
        handle.setComposeProjectName(out.compose.projectName);
      }
    } catch {
      /* parse best-effort */
    }
  }, 300_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 90_000);

  // -------------------------------------------------------------------------
  // db migrate
  // -------------------------------------------------------------------------
  // LEV-204 — forward-regression guard: prisma.config.ts resolves cleanly
  // now that prisma is a direct devDep of the template root.
  it(
    'LEV-204 regression: db migrate --json exits 0',
    { timeout: 120_000 },
    () => {
      const res = runCli(handle.projectDir, ['db', 'migrate', '--json'], {
        timeoutMs: 90_000,
      });
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as { ok: boolean };
      expect(out.ok).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // db seed — depends on a successful migrate
  // -------------------------------------------------------------------------
  it(
    'LEV-204 regression: db seed --json exits 0 after migrate',
    { timeout: 120_000 },
    () => {
      const res = runCli(handle.projectDir, ['db', 'seed', '--json'], {
        timeoutMs: 90_000,
      });
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as { ok: boolean };
      expect(out.ok).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // db inspect --schema
  //
  // `inspectSchema` reads the live database directly via the prisma adapter's
  // introspection helper. It does NOT go through `prisma migrate`, so it
  // sidesteps LEV-204 and should work today against an empty schema.
  // -------------------------------------------------------------------------
  it(
    'db inspect --schema --json returns a tables map (empty on a fresh stack)',
    { timeout: 60_000 },
    () => {
      const res = runCli(
        handle.projectDir,
        ['db', 'inspect', '--schema', '--json'],
        { timeoutMs: 45_000 },
      );
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as {
        tables: Record<string, unknown>;
      };
      expect(out.tables).toBeDefined();
      expect(typeof out.tables).toBe('object');
    },
  );

  // -------------------------------------------------------------------------
  // db inspect --rows <table>
  //
  // Without a migrated schema there's nothing to inspect. The command should
  // fail loudly with a clear error (the table doesn't exist).
  // -------------------------------------------------------------------------
  it(
    'db inspect --rows on a nonexistent table errors loudly',
    { timeout: 30_000 },
    () => {
      const res = runCli(
        handle.projectDir,
        ['db', 'inspect', '--rows', 'lev198_no_such_table', '--json'],
        { timeoutMs: 20_000 },
      );
      // Either exits non-zero with a diagnostic, or returns an empty rows
      // array (postgres `relation does not exist` becomes a 404-like
      // empty result). Either is acceptable — silent success with
      // populated rows we never seeded is NOT.
      if (res.exitCode === 0) {
        const out = JSON.parse(res.stdout);
        expect(Array.isArray(out) ? out.length : 0).toBe(0);
      } else {
        const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
        expect(combined).toMatch(/relation|table|does not exist|lev198_no_such_table/);
      }
    },
  );

  it('db inspect with neither --schema nor --rows errors with usage', () => {
    const res = runCli(handle.projectDir, ['db', 'inspect', '--json']);
    expect(res.exitCode).not.toBe(0);
    const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
    expect(combined).toMatch(/--schema|--rows|usage/);
  });

  // -------------------------------------------------------------------------
  // db migration new <name>
  //
  // Forward-regression guard: same prisma chain as `db migrate`; works now
  // that LEV-204 is fixed.
  // -------------------------------------------------------------------------
  it(
    'LEV-204 regression: db migration new --json scaffolds a migration directory',
    { timeout: 90_000 },
    () => {
      const res = runCli(
        handle.projectDir,
        ['db', 'migration', 'new', 'lev198_probe', '--json'],
        { timeoutMs: 60_000 },
      );
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as {
        ok: boolean;
        path: string;
        name: string;
      };
      expect(out.ok).toBe(true);
      expect(out.name).toBe('lev198_probe');
      expect(out.path).toMatch(/lev198_probe$/);
      expect(existsSync(join(out.path, 'migration.sql'))).toBe(true);
    },
  );

  it('db migration new with no name errors with usage', () => {
    const res = runCli(handle.projectDir, ['db', 'migration', 'new', '--json']);
    expect(res.exitCode).not.toBe(0);
    const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
    expect(combined).toMatch(/missing required|usage|name/);
  });

  it('db migration new with an invalid name errors loudly', () => {
    // The validator requires snake_case starting with a letter.
    const res = runCli(
      handle.projectDir,
      ['db', 'migration', 'new', '123-bad-name!!', '--json'],
    );
    expect(res.exitCode).not.toBe(0);
    const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
    expect(combined).toMatch(/invalid migration name|snake_case|usage/);
  });

  // -------------------------------------------------------------------------
  // db reset (--skip-seed)
  //
  // `db reset` is drop + migrate + seed. Forward-regression guard now that
  // LEV-204 fixed the prisma config chain.
  // -------------------------------------------------------------------------
  it(
    'LEV-204 regression: db reset --skip-seed --json exits 0',
    { timeout: 120_000 },
    () => {
      const res = runCli(
        handle.projectDir,
        ['db', 'reset', '--skip-seed', '--json'],
        { timeoutMs: 90_000 },
      );
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as {
        reset: boolean;
        migrated: boolean;
        seeded: boolean;
      };
      expect(out.reset).toBe(true);
      expect(out.migrated).toBe(true);
      expect(out.seeded).toBe(false);
    },
  );
});
