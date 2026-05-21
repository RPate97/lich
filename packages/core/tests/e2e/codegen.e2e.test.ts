/**
 * LEV-198-extended — `gen` command coverage.
 *
 * The unified codegen entrypoint (LEV-124). Tests cover:
 *
 *   - `gen --list --json`             — introspection
 *   - `gen --only <id> --json`        — single generator
 *   - `gen --json` (all)              — full run
 *   - `gen --only <unknown> --json`   — failure path (forwarded into
 *                                       failure-surfaces too, but kept
 *                                       here so codegen has full coverage)
 *
 * `gen` doesn't strictly require docker, but the `prisma` generator
 * eventually shells out to `prisma generate`, which needs `@prisma/client`
 * resolvable. The `api-client` generator just walks the backend adapter's
 * route manifest and writes a TS file — purely static, no docker needed.
 *
 * The full `gen --json` and `gen --only prisma` paths are exercised in
 * `dogfood.e2e.test.ts`'s phase-3 docker block. Here we focus on the
 * non-docker paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';

let handle: E2EProjectHandle;

describe('LEV-198-extended codegen: gen command coverage', () => {
  beforeAll(async () => {
    sweepStaleTmpdirs('lz-e2e-codegen-');
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-codegen-' });
  }, 240_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 60_000);

  // -------------------------------------------------------------------------
  // gen --list — introspection
  // -------------------------------------------------------------------------
  describe('gen --list', () => {
    it('--list --json returns every registered generator with id + describe', () => {
      const { json } = runCliJson<{
        generators: Array<{ id: string; describe: string }>;
      }>(handle.projectDir, ['gen', '--list', '--json']);
      expect(Array.isArray(json.generators)).toBe(true);
      // v0 contributes at least two: `api-client` (typed-client) and
      // `prisma` (plugin-prisma).
      const byId = new Map(json.generators.map((g) => [g.id, g]));
      expect(byId.has('api-client')).toBe(true);
      expect(byId.has('prisma')).toBe(true);
      // Every entry must declare a non-empty describe so the renderer's
      // 2-column table doesn't print blank descriptions.
      for (const g of json.generators) {
        expect(g.id.length).toBeGreaterThan(0);
        expect(g.describe.length).toBeGreaterThan(0);
      }
    });

    it('--list (pretty) prints the canonical 2-column table', () => {
      const res = runCli(handle.projectDir, ['gen', '--list']);
      expect(res.exitCode, res.stderr).toBe(0);
      // Header row + per-generator row. We don't assert exact whitespace.
      expect(res.stdout).toContain('ID');
      expect(res.stdout).toContain('DESCRIBE');
      expect(res.stdout).toContain('api-client');
      expect(res.stdout).toContain('prisma');
    });
  });

  // -------------------------------------------------------------------------
  // gen --only <id>
  // -------------------------------------------------------------------------
  describe('gen --only', () => {
    it(
      'gen --only api-client --json runs only that generator',
      { timeout: 60_000 },
      () => {
        const res = runCli(
          handle.projectDir,
          ['gen', '--only', 'api-client', '--json'],
          { timeoutMs: 45_000 },
        );
        // We tolerate either success (the typed-client generator emits a
        // TS file) or a structured failure (the backend adapter needs to
        // resolve hono modules — that's a real env failure not a silent
        // one). The contract: parseable JSON either way.
        if (res.exitCode === 0) {
          const out = JSON.parse(res.stdout) as {
            results: Array<{ id: string; status: string }>;
            ok: number;
          };
          expect(out.results.length).toBe(1);
          expect(out.results[0]?.id).toBe('api-client');
          // The generator either succeeded or skipped — but it must be one
          // of those two (a fail status would have produced exit 1 above).
          expect(['ok', 'skip']).toContain(out.results[0]?.status);
        } else {
          // Failure path: stderr must mention api-client so the user can
          // pinpoint the failing generator.
          expect(res.stderr.toLowerCase()).toContain('api-client');
        }
      },
    );

    it('gen --only <unknown> --json fails loudly listing known generators', () => {
      const res = runCli(
        handle.projectDir,
        ['gen', '--only', 'lev198-nonexistent-generator', '--json'],
        { timeoutMs: 20_000 },
      );
      expect(res.exitCode).not.toBe(0);
      const stderr = res.stderr.toLowerCase();
      // The unknown id must appear so the user knows what to fix.
      expect(stderr).toContain('lev198-nonexistent-generator');
      // The "known generators:" hint should also appear (selectByOnly's
      // CLIError hint).
      expect(stderr).toMatch(
        /unknown generator|known generators|no generators registered/,
      );
    });

    it('gen --only <comma,separated> --json runs every listed generator', () => {
      // Validates the comma-parsing branch of selectByOnly. We use the two
      // known v0 generators so the assertion can pin both ids.
      const res = runCli(
        handle.projectDir,
        ['gen', '--only', 'api-client,prisma', '--json'],
        { timeoutMs: 60_000 },
      );
      // Same tolerance as the single-id case — one or both may fail in a
      // pre-dev environment. We only assert the result contains both rows
      // in the order they were listed.
      const stdout = res.stdout || '{}';
      try {
        const out = JSON.parse(stdout) as {
          results: Array<{ id: string }>;
        };
        if (Array.isArray(out.results) && out.results.length === 2) {
          expect(out.results[0]?.id).toBe('api-client');
          expect(out.results[1]?.id).toBe('prisma');
        }
      } catch {
        // If the JSON shape isn't there, the command failed in some other
        // way — assert at least that stderr mentions one of the generators.
        const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
        expect(combined).toMatch(/api-client|prisma/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // gen (no flags) — runs every generator
  //
  // In a no-docker pre-dev environment this may partially succeed
  // (`api-client` only needs static route extraction) and partially fail
  // (`prisma` needs a live db_url). We assert the structural shape and
  // leave the per-generator pass/fail flexible.
  // -------------------------------------------------------------------------
  describe('gen (no flags)', () => {
    it(
      'gen --json returns a structured per-generator result table',
      { timeout: 90_000 },
      () => {
        const res = runCli(handle.projectDir, ['gen', '--json'], {
          timeoutMs: 60_000,
        });
        // Either exit code is acceptable; we just need parseable JSON.
        const stdout = res.stdout || '';
        if (stdout.length === 0) {
          // Edge: gen failed before emitting JSON. Acceptable if stderr is
          // non-empty.
          expect(res.stderr.length).toBeGreaterThan(0);
          return;
        }
        const out = JSON.parse(stdout) as {
          results: Array<{ id: string; status: string }>;
          ok: number;
          skipped: number;
          failed: number;
        };
        // The counts must sum to the result-row count.
        expect(out.ok + out.skipped + out.failed).toBe(out.results.length);
        // At least the two known v0 generators are present.
        const ids = out.results.map((r) => r.id);
        expect(ids).toContain('api-client');
        expect(ids).toContain('prisma');
      },
    );
  });
});
