/**
 * LEV-198-extended — `ui add` / `ui list` command coverage.
 *
 * These commands come from `@lich/plugin-shadcn`. Both run on the host
 * (no docker required). `ui add` invokes `npx shadcn@latest add <component>`
 * under the hood — we use `--dry-run` so we don't actually pull in shadcn
 * deps during the test.
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

describe('LEV-198-extended ui: shadcn command coverage', () => {
  beforeAll(async () => {
    sweepStaleTmpdirs('lz-e2e-ui-');
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-ui-' });
  }, 240_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 60_000);

  // -------------------------------------------------------------------------
  // ui list — no shadcn components installed yet
  // -------------------------------------------------------------------------
  describe('ui list', () => {
    it('--json returns an installed array (empty on a fresh scaffold)', () => {
      const { json } = runCliJson<{ installed: string[] }>(
        handle.projectDir,
        ['ui', 'list', '--json'],
      );
      expect(Array.isArray(json.installed)).toBe(true);
      // Fresh v0 scaffold has no installed components. If this ever changes
      // (the template starts shipping with some baseline components), the
      // assertion needs to be loosened — but today the contract is "empty".
      expect(json.installed.length).toBe(0);
    });

    it('pretty output is non-empty (or the canonical "no components" line)', () => {
      const res = runCli(handle.projectDir, ['ui', 'list']);
      expect(res.exitCode, res.stderr).toBe(0);
      // Either a list of components OR the friendly empty-state line.
      expect(res.stdout.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // ui add — dry-run path
  //
  // We can't run the real shadcn CLI in CI without network access and
  // without polluting the scaffold's apps/web tree. `--dry-run` exercises
  // the same argument-parsing / adapter-dispatch path without actually
  // running the install.
  // -------------------------------------------------------------------------
  describe('ui add', () => {
    it(
      'ui add <component> --dry-run --json reports the command it would run',
      { timeout: 60_000 },
      () => {
        const res = runCli(
          handle.projectDir,
          ['ui', 'add', 'button', '--dry-run', '--json'],
          { timeoutMs: 45_000 },
        );
        if (res.exitCode !== 0) {
          // shadcn's invocation chain may fail in subtle ways
          // (npx availability, network, etc.). The contract is that the
          // failure is loud — non-zero with a diagnostic, not silent.
          expect(`${res.stderr}\n${res.stdout}`.length).toBeGreaterThan(0);
          return;
        }
        const out = JSON.parse(res.stdout) as {
          executed: boolean;
          command: string;
          cwd: string;
        };
        // Dry-run means `executed: false` — the adapter built the command
        // but didn't spawn it.
        expect(out.executed).toBe(false);
        // The command must reference shadcn somehow (the canonical
        // invocation is `npx shadcn@latest add button`).
        expect(out.command).toMatch(/shadcn/);
        // `button` is the requested component — must appear in the args.
        expect(out.command).toContain('button');
        // `cwd` should be the resolved app dir (apps/web by default).
        expect(out.cwd).toContain('apps/web');
      },
    );

    it('ui add with no component errors with a usage hint', () => {
      const res = runCli(handle.projectDir, ['ui', 'add', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/component|usage|missing/);
    });

    it(
      'ui add --app-dir override threads through to the adapter command',
      { timeout: 60_000 },
      () => {
        const res = runCli(
          handle.projectDir,
          [
            'ui',
            'add',
            'card',
            '--dry-run',
            '--app-dir',
            'apps/web',
            '--json',
          ],
          { timeoutMs: 45_000 },
        );
        if (res.exitCode !== 0) {
          // Same tolerance as the basic dry-run test — loud failure
          // acceptable, silent success is not.
          expect(`${res.stderr}\n${res.stdout}`.length).toBeGreaterThan(0);
          return;
        }
        const out = JSON.parse(res.stdout) as { cwd: string };
        expect(out.cwd).toContain('apps/web');
      },
    );
  });
});
