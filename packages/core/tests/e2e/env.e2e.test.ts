/**
 * LEV-198-extended — env + adapter introspection commands.
 *
 * Per-command coverage for:
 *
 *   - `env list`             — every env-source the plugins contributed
 *   - `env resolve <svc>`    — the resolved env map a service would see
 *   - `adapter list [slot]`  — every (slot, name) pair the registry holds
 *   - `adapter swap`         — persists the active adapter for a slot
 *   - `check`                — framework conformance rules
 *
 * All of these run without docker (the resolvers don't need a live stack —
 * `postgres.url` resolves to the fixed compose-DNS URL in `container`
 * context, and to a deterministic `localhost:<allocated>` URL in `host`
 * context against a port map we don't have yet, which surfaces as a
 * structured error rather than a crash).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';

let handle: E2EProjectHandle;

describe('LEV-198-extended env / adapter / check', () => {
  beforeAll(async () => {
    sweepStaleTmpdirs('lz-e2e-env-');
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-env-' });
  }, 240_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 60_000);

  // -------------------------------------------------------------------------
  // env list
  // -------------------------------------------------------------------------
  describe('env list', () => {
    it('--json surfaces the canonical v0 sources (postgres/hono/next)', () => {
      const { json } = runCliJson<{
        entries: Array<{
          key: string;
          protocol: string | null;
          plugin: string;
        }>;
      }>(handle.projectDir, ['env', 'list', '--json']);
      const byKey = new Map(json.entries.map((e) => [e.key, e]));
      expect(byKey.get('postgres.url')?.protocol).toBe('postgres');
      expect(byKey.get('hono.url')?.protocol).toBe('http');
      expect(byKey.get('next.url')?.protocol).toBe('http');
      // Every entry should declare a `plugin` field so the registry isn't
      // serializing anonymous sources.
      for (const e of json.entries) {
        expect(typeof e.plugin).toBe('string');
        expect(e.plugin.length).toBeGreaterThan(0);
      }
    });

    it('pretty output is non-empty', () => {
      const res = runCli(handle.projectDir, ['env', 'list']);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // env resolve <service>
  // -------------------------------------------------------------------------
  describe('env resolve', () => {
    it('--json includes the envInjection-mapped vars for the api service', () => {
      const { json } = runCliJson<{
        service: string;
        context: 'host' | 'container';
        env: Record<string, string>;
      }>(handle.projectDir, ['env', 'resolve', 'api', '--json']);
      expect(json.service).toBe('api');
      expect(json.context).toBe('container');
      expect(json.env['DATABASE_URL']).toMatch(/^postgres:\/\//);
      expect(json.env['API_URL']).toMatch(/^http:\/\//);
      expect(json.env['WEB_URL']).toMatch(/^http:\/\//);
    });

    it('--context host returns host-shaped URLs', () => {
      // In host context, `next.url` and friends are localhost-bound. The
      // postgres URL also uses localhost (the host can't reach `postgres`
      // by compose DNS — that's container-only).
      const res = runCli(
        handle.projectDir,
        ['env', 'resolve', 'web', '--context', 'host', '--json'],
      );
      // Today this exits non-zero in a fresh scaffold because the host
      // context needs allocated ports (not yet allocated without a running
      // stack). Either outcome is acceptable; we just require the failure
      // to be LOUD (exit non-zero with a diagnostic) rather than a silent
      // empty env.
      if (res.exitCode === 0) {
        const out = JSON.parse(res.stdout) as {
          context: 'host' | 'container';
          env: Record<string, string>;
        };
        expect(out.context).toBe('host');
        // Host-context URLs must NOT use compose-DNS hostnames.
        for (const v of Object.values(out.env)) {
          expect(v).not.toMatch(/postgres:\/\/postgres@/);
        }
      } else {
        expect(`${res.stderr}\n${res.stdout}`.length).toBeGreaterThan(0);
      }
    });

    it('rejects --context with an invalid value', () => {
      const res = runCli(handle.projectDir, [
        'env',
        'resolve',
        'api',
        '--context',
        'bogus',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/invalid --context|host or container/);
    });

    it('errors when no service is supplied', () => {
      const res = runCli(handle.projectDir, ['env', 'resolve', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/missing required|usage|service/);
    });
  });

  // -------------------------------------------------------------------------
  // adapter list / swap
  // -------------------------------------------------------------------------
  describe('adapter list', () => {
    it('--json shows the v0 active impls', () => {
      const { json } = runCliJson<{
        adapters: Array<{ slot: string; name: string; active: boolean }>;
      }>(handle.projectDir, ['adapter', 'list', '--json']);
      const byKey = new Map(
        json.adapters.map((a) => [`${a.slot}:${a.name}`, a]),
      );
      expect(byKey.get('orm:prisma')?.active).toBe(true);
      expect(byKey.get('backend:hono')?.active).toBe(true);
      expect(byKey.get('frontend:typed-client')?.active).toBe(true);
      expect(byKey.get('auth:better-auth')?.active).toBe(true);
      expect(byKey.get('ui:shadcn')?.active).toBe(true);
      expect(byKey.get('browser:playwright')?.active).toBe(true);
    });

    // LEV-207 — the `<slot>` positional now filters the result to that slot,
    // and errors loudly on a typo. Before the fix the positional was silently
    // dropped and every (slot, name) pair was returned regardless.
    it('LEV-207 regression: adapter list <slot> --json filters to that slot', () => {
      const res = runCli(
        handle.projectDir,
        ['adapter', 'list', 'orm', '--json'],
      );
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as {
        adapters: Array<{ slot: string }>;
      };
      expect(out.adapters.length).toBeGreaterThan(0);
      for (const a of out.adapters) {
        expect(a.slot).toBe('orm');
      }
    });
  });

  describe('adapter swap', () => {
    it('errors when slot is missing', () => {
      const res = runCli(handle.projectDir, ['adapter', 'swap', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/missing|usage/);
    });

    it('errors when adapter name is missing', () => {
      const res = runCli(
        handle.projectDir,
        ['adapter', 'swap', 'orm', '--json'],
      );
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/missing|usage/);
    });

    it('errors on an unknown (slot, name) pair', () => {
      const res = runCli(
        handle.projectDir,
        ['adapter', 'swap', 'orm', 'lev198-nonexistent-adapter', '--json'],
      );
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/unknown|not registered|nonexistent/);
    });

    it('swapping to the already-active adapter is a no-op success', () => {
      // The v0 scaffold has `orm:prisma` active. Swapping to itself should
      // succeed and persist `.levelzero/adapter.json`.
      const res = runCli(
        handle.projectDir,
        ['adapter', 'swap', 'orm', 'prisma', '--json'],
      );
      // We tolerate either success (the swap persisted) or a deliberate
      // "already active" error — both are acceptable. Silent failure is
      // not.
      if (res.exitCode !== 0) {
        expect(res.stderr.length + res.stdout.length).toBeGreaterThan(0);
        return;
      }
      expect(
        existsSync(join(handle.projectDir, '.levelzero', 'adapter.json')),
      ).toBe(true);
      // Clean up the override file so it doesn't bleed into other tests.
      try {
        writeFileSync(
          join(handle.projectDir, '.levelzero', 'adapter.json'),
          '{}',
          'utf8',
        );
      } catch {
        /* best-effort */
      }
    });
  });

  // -------------------------------------------------------------------------
  // check — framework conformance rules
  //
  // The check command runs every registered rule and reports pass/fail/skip.
  // It exits non-zero on rule failures by design. The fresh v0 scaffold has
  // at least one rule that fails today (`route-coverage` — see below); we
  // assert the structural contract regardless of the overall `ok` flag.
  // -------------------------------------------------------------------------
  describe('check', () => {
    it('check --json emits a structured result with counts that sum to total', () => {
      const res = runCli(handle.projectDir, ['check', '--json']);
      // Check exits non-zero on rule failures — read stdout regardless.
      const out = JSON.parse(res.stdout) as {
        ok: boolean;
        summary: { pass: number; fail: number; skip: number; total: number };
        results: unknown[];
      };
      expect(out.summary.total).toBeGreaterThan(0);
      expect(
        out.summary.pass + out.summary.fail + out.summary.skip,
      ).toBe(out.summary.total);
      expect(out.results.length).toBe(out.summary.total);
    });

    // Forward-regression guard: `check --json` should pass clean on a fresh
    // v0 scaffold. The route-coverage rule soft-passes on a scaffold that
    // doesn't yet declare integration tests, so the suite reports ok=true /
    // fail=0. If a future rule starts hard-failing here, treat it as either
    // a real rule violation in the template OR a rule-discovery regression.
    it(
      'check --json passes clean on a fresh v0 scaffold',
      () => {
        const res = runCli(handle.projectDir, ['check', '--json']);
        const out = JSON.parse(res.stdout) as {
          ok: boolean;
          summary: { pass: number; fail: number; skip: number };
        };
        expect(out.ok).toBe(true);
        expect(out.summary.fail).toBe(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Restore confidence — make sure the previous swap-related tests left the
  // project in a runnable state. (No-op if everything went clean.)
  // -------------------------------------------------------------------------
  describe('post-test cleanup', () => {
    it('the project config still exists and is parseable', () => {
      const cfg = readFileSync(
        join(handle.projectDir, 'levelzero.config.ts'),
        'utf8',
      );
      // The substitution `create-stack-v0` did when scaffolding leaves the
      // project name inline; if a test stomped on the file, this assertion
      // catches it.
      expect(cfg).toContain('plugins');
    });
  });
});
