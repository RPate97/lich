/**
 * LEV-198-extended — failure-path coverage for every CLI command.
 *
 * The premise (per LEV-197 + LEV-198): every command must fail LOUDLY with
 * an actionable stderr, never silently with exit 0 and an empty body.
 *
 * These tests assert the negative path for the full command surface:
 *
 *   - missing required arg / flag
 *   - unknown id / slot / service
 *   - "no stack running" path for commands that need `dev` first
 *   - empty / invalid flag values
 *
 * No docker is needed for any of these — every failure case fires before
 * the command reaches a docker call. (The corresponding success-path tests
 * live in the per-surface files.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli } from './_helpers/cli';

let handle: E2EProjectHandle;

describe('LEV-198-extended failure surfaces', () => {
  beforeAll(async () => {
    sweepStaleTmpdirs('lz-e2e-failures-');
    handle = await setupScaffoldedProject({
      tmpdirPrefix: 'lz-e2e-failures-',
    });
  }, 240_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Unknown command — should NOT exit 0 silently
  // -------------------------------------------------------------------------
  describe('unknown command', () => {
    it('an unknown command fails loudly', () => {
      const res = runCli(handle.projectDir, [
        'lev198-not-a-real-command',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      // Either "unknown command" or the help output mentioning available
      // commands — both are acceptable, silent success is not.
      expect(combined).toMatch(
        /unknown|not.*registered|usage|help|available|lev198-not-a-real-command/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // env resolve — unknown service / missing service / bad flags
  // -------------------------------------------------------------------------
  describe('env resolve failures', () => {
    it('unknown service surfaces a structured response (not a silent empty success)', () => {
      const res = runCli(
        handle.projectDir,
        ['env', 'resolve', 'lev198-nonexistent-service', '--json'],
        { timeoutMs: 20_000 },
      );
      // Two acceptable outcomes:
      //   1. Exit non-zero with a diagnostic.
      //   2. Exit 0 with an empty/echoed result (current behavior —
      //      envInjection is global, not per-service).
      if (res.exitCode !== 0) {
        expect(res.stderr.length).toBeGreaterThan(0);
      } else {
        const out = JSON.parse(res.stdout) as {
          service: string;
          env: Record<string, string>;
        };
        expect(out.service).toBe('lev198-nonexistent-service');
        expect(out.env).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // gen — unknown id, empty --only
  // -------------------------------------------------------------------------
  describe('gen failures', () => {
    it('gen --only <unknown> fails loudly listing known generators', () => {
      const res = runCli(
        handle.projectDir,
        ['gen', '--only', 'lev198-nonexistent-generator', '--json'],
        { timeoutMs: 20_000 },
      );
      expect(res.exitCode).not.toBe(0);
      const stderr = res.stderr.toLowerCase();
      expect(stderr).toContain('lev198-nonexistent-generator');
      expect(stderr).toMatch(
        /unknown generator|known generators|no generators registered/,
      );
    });

    it('gen --only "" (empty) is a no-op success or fails loudly', () => {
      // selectByOnly drops empty entries; an entirely empty list means the
      // run selects nothing → success with 0 results. Acceptable, but it
      // must NOT silently run every generator.
      const res = runCli(
        handle.projectDir,
        ['gen', '--only', '', '--json'],
        { timeoutMs: 20_000 },
      );
      if (res.exitCode === 0) {
        const out = JSON.parse(res.stdout) as {
          results: unknown[];
        };
        expect(out.results.length).toBe(0);
      } else {
        expect(res.stderr.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // db.* commands — pre-dev "no stack" path
  //
  // Every db.* command requires a running stack (it pulls DATABASE_URL from
  // the registry entry). Pre-dev they MUST fail loudly with a NO_PROJECT
  // CLIError pointing at `levelzero dev`.
  // -------------------------------------------------------------------------
  describe('db.* without a running stack', () => {
    const subcommands = [
      ['db', 'migrate'],
      ['db', 'seed'],
      ['db', 'inspect', '--schema'],
      ['db', 'reset', '--skip-seed'],
      ['db', 'migration', 'new', 'lev198_probe'],
    ] as const;

    for (const args of subcommands) {
      it(
        `${args.join(' ')} pre-dev fails with NO_PROJECT and a hint`,
        { timeout: 30_000 },
        () => {
          const res = runCli(
            handle.projectDir,
            [...args, '--json'],
            { timeoutMs: 20_000 },
          );
          expect(res.exitCode).not.toBe(0);
          const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
          // Either the canonical NO_PROJECT message OR a clear pointer to
          // `levelzero dev`. Empty stderr is forbidden.
          expect(combined).toMatch(/no stack|levelzero dev|no_project/);
        },
      );
    }
  });

  // -------------------------------------------------------------------------
  // adapter swap — missing args / unknown values
  // -------------------------------------------------------------------------
  describe('adapter swap failures', () => {
    it('missing slot errors with usage', () => {
      const res = runCli(handle.projectDir, ['adapter', 'swap', '--json']);
      expect(res.exitCode).not.toBe(0);
      expect(`${res.stderr}\n${res.stdout}`.length).toBeGreaterThan(0);
    });

    it('unknown slot errors loudly', () => {
      const res = runCli(handle.projectDir, [
        'adapter',
        'swap',
        'lev198-nonexistent-slot',
        'something',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/unknown|not registered|invalid|nonexistent/);
    });
  });

  // -------------------------------------------------------------------------
  // compose — no subcommand, no compose file
  // -------------------------------------------------------------------------
  describe('compose failures', () => {
    it('compose with no subcommand errors with usage', () => {
      const res = runCli(handle.projectDir, ['compose', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/subcommand|usage/);
    });

    it('compose ps before dev errors with a hint pointing at dev', () => {
      const res = runCli(handle.projectDir, ['compose', 'ps', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/no compose file|levelzero dev/);
    });
  });

  // -------------------------------------------------------------------------
  // ui add — missing component
  // -------------------------------------------------------------------------
  describe('ui add failures', () => {
    it('ui add with no component name errors with usage', () => {
      const res = runCli(handle.projectDir, ['ui', 'add', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/component|usage|missing/);
    });
  });

  // -------------------------------------------------------------------------
  // init — already-exists guard, name path missing --template-dir
  // -------------------------------------------------------------------------
  describe('init failures', () => {
    it('init without --force errors when config already exists', () => {
      const res = runCli(handle.projectDir, ['init', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/already exists|force/);
    });

    it('init <name> without --template-dir errors with a hint', () => {
      const res = runCli(handle.projectDir, [
        'init',
        'lev198-other-app',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/template[ -]dir|create-stack-v0/);
    });
  });

  // -------------------------------------------------------------------------
  // stacks stop — destructive command must require --all
  // -------------------------------------------------------------------------
  describe('stacks stop failures', () => {
    it('stacks stop without --all errors with a usage hint', () => {
      const res = runCli(handle.projectDir, ['stacks', 'stop', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/--all|not supported|usage/);
    });
  });

  // -------------------------------------------------------------------------
  // urls — outside-project (no levelzero.config.ts) error
  // -------------------------------------------------------------------------
  describe('urls failures', () => {
    it(
      'urls outside a levelzero project errors with NO_PROJECT',
      { timeout: 30_000 },
      () => {
        // Run urls from the tmpdir parent, which has no levelzero.config.ts.
        const res = runCli(handle.tmpdir, ['urls', '--json'], {
          timeoutMs: 15_000,
        });
        expect(res.exitCode).not.toBe(0);
        const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
        expect(combined).toMatch(/no_project|not inside|levelzero.config/);
      },
    );
  });

  // -------------------------------------------------------------------------
  // db.* migration new — invalid name path
  // -------------------------------------------------------------------------
  describe('db migration new failures', () => {
    it('invalid migration name errors loudly', () => {
      // Must include a valid-stack guard later, but the name validator
      // fires FIRST (before the stack lookup), so this hits the
      // CONFIG_INVALID path without needing docker.
      const res = runCli(handle.projectDir, [
        'db',
        'migration',
        'new',
        '!!invalid!!',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/invalid migration name|snake_case/);
    });
  });
});
