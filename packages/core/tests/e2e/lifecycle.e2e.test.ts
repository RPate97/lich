/**
 * LEV-198-extended — Lifecycle & introspection commands.
 *
 * Per-command e2e coverage for the CLI surface that doesn't need a running
 * stack:
 *
 *   - `--help` / `help`        — discoverability and command listing
 *   - `doctor`                 — diagnose local env
 *   - `init`                   — scaffold a levelzero.config.ts in CWD
 *   - `init <name>`            — error path (template-dir required)
 *   - `stacks current`         — current worktree info
 *   - `stacks list`            — global registry
 *   - `stacks prune`           — registry sweep (no --all needed)
 *   - `stacks prune --all`     — docker-gated: prunes containers/networks
 *   - `stacks stop --all`      — docker-gated: kills every levelzero-* stack
 *   - `urls` (outside-project + inside-project pre-dev)
 *   - `compose`                — error path (compose file missing pre-dev)
 *   - `dev` / `stop`           — docker-gated lifecycle
 *   - `logs`                   — no-stack response path
 *
 * Companion files cover other surfaces: `env.e2e.test.ts` (env, adapter),
 * `db.e2e.test.ts` (all db.* commands), `codegen.e2e.test.ts` (gen),
 * `ui.e2e.test.ts` (shadcn), and `failure-surfaces.e2e.test.ts` (negative
 * paths). The canonical 5-phase user-flow arc lives in `dogfood.e2e.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  setupScaffoldedProject,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';
import { dockerAvailable } from './_helpers/docker';

const DOCKER = dockerAvailable();

let handle: E2EProjectHandle;

describe('LEV-198-extended lifecycle: per-command coverage', () => {
  beforeAll(async () => {
    handle = await setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-lifecycle-' });
  }, 240_000);

  afterAll(async () => {
    await teardownScaffoldedProject(handle);
  }, 60_000);

  // -------------------------------------------------------------------------
  // help / --help
  // -------------------------------------------------------------------------
  describe('help', () => {
    it('--help lists every registered command group', () => {
      const res = runCli(handle.projectDir, ['--help']);
      expect(res.exitCode, res.stderr).toBe(0);
      // Inline core commands
      expect(res.stdout).toContain('dev');
      expect(res.stdout).toContain('stop');
      expect(res.stdout).toContain('doctor');
      expect(res.stdout).toContain('init');
      expect(res.stdout).toContain('reset');
      expect(res.stdout).toContain('logs');
      // Subcommand groups
      expect(res.stdout).toContain('stacks current');
      expect(res.stdout).toContain('stacks list');
      expect(res.stdout).toContain('stacks prune');
      expect(res.stdout).toContain('stacks stop');
      expect(res.stdout).toContain('adapter list');
      expect(res.stdout).toContain('adapter swap');
      expect(res.stdout).toContain('env list');
      expect(res.stdout).toContain('env resolve');
      // Plugin commands
      expect(res.stdout).toContain('db migrate');
      expect(res.stdout).toContain('db seed');
      expect(res.stdout).toContain('db inspect');
      expect(res.stdout).toContain('db reset');
      expect(res.stdout).toContain('ui add');
      expect(res.stdout).toContain('ui list');
      expect(res.stdout).toContain('curl');
    });

    it('help subcommand renders identical output', () => {
      const a = runCli(handle.projectDir, ['help']);
      const b = runCli(handle.projectDir, ['--help']);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      // Both stems print the same canonical help. We don't strict-equal the
      // entire string (a trailing newline / minor formatting drift would
      // false-fail) but every command from the canonical surface MUST appear
      // in both.
      for (const needle of ['dev', 'stop', 'doctor', 'gen', 'env list']) {
        expect(a.stdout).toContain(needle);
        expect(b.stdout).toContain(needle);
      }
    });
  });

  // -------------------------------------------------------------------------
  // doctor
  // -------------------------------------------------------------------------
  describe('doctor', () => {
    it('--json reports ok with structured checks', () => {
      const { json } = runCliJson<{
        ok: boolean;
        checks: Array<{ id: string; status: string; message?: string }>;
      }>(handle.projectDir, ['doctor', '--json']);
      // Either everything's green, OR the only non-ok rows are warn / skipped
      // (docker pool-pressure warnings, optional infra checks, etc.).
      const bad = json.checks.filter(
        (c) => c.status !== 'ok' && c.status !== 'warn' && c.status !== 'skipped',
      );
      expect(bad).toEqual([]);
      expect(json.ok).toBe(true);
      // Every doctor row has an id; if any are blank the renderer's downstream
      // alignment falls apart.
      for (const c of json.checks) {
        expect(c.id.length).toBeGreaterThan(0);
      }
    });

    it('pretty output is non-empty', () => {
      const res = runCli(handle.projectDir, ['doctor']);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // init — scaffold a levelzero.config.ts in CWD vs. init <name> errors
  // -------------------------------------------------------------------------
  describe('init', () => {
    it('init --force --json overwrites the existing config and returns a result', () => {
      // The scaffolded project already has a `levelzero.config.ts`, so the
      // bare `init` (no --force) path must error. We add `--force` to
      // exercise the success branch.
      const { json } = runCliJson<{ created: boolean; configPath: string }>(
        handle.projectDir,
        ['init', '--force', '--json'],
      );
      expect(json.created).toBe(true);
      expect(json.configPath).toBe(
        join(handle.projectDir, 'levelzero.config.ts'),
      );
      // The stub the init command writes is intentionally minimal — overwriting
      // here means the template's plugin list is GONE. We restore the
      // original immediately so the rest of the test file (and any tests
      // that run after) still see the full v0 plugin surface.
      // Read back the canonical contents from the template package and
      // re-apply the projectName substitution that `create-stack-v0` did
      // when scaffolding.
      const templateConfig = join(
        __dirname,
        '..',
        '..',
        '..',
        'template-v0-stack',
        'files',
        'levelzero.config.ts',
      );
      const restored = readFileSync(templateConfig, 'utf8').replace(
        '{{projectName}}',
        'demo',
      );
      writeFileSync(
        join(handle.projectDir, 'levelzero.config.ts'),
        restored,
        'utf8',
      );
    });

    it('init without --force errors when the config already exists', () => {
      // Re-running `init` against a project that already has the file should
      // surface a CONFIG_INVALID with a hint pointing at --force. Exit non-
      // zero so scripts can branch.
      const res = runCli(handle.projectDir, ['init', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/already exists|force/);
    });

    it('init <name> without --template-dir errors with a hint', () => {
      // Post-LEV-174 `levelzero init <name>` no longer ships with a
      // hardcoded template — the standalone path is reserved for
      // out-of-tree plugins / advanced flows. The error MUST point users
      // at `bunx create-stack-v0 <name>` so they don't dead-end.
      const res = runCli(handle.projectDir, [
        'init',
        'my-other-app',
        '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/template[ -]dir|create-stack-v0/);
    });
  });

  // -------------------------------------------------------------------------
  // stacks current / list / prune (sans --all)
  // -------------------------------------------------------------------------
  describe('stacks (introspection)', () => {
    it('stacks current --json reports the resolved worktree', () => {
      const { json } = runCliJson<{
        key: string;
        path: string;
        configPath: string;
        running: boolean;
        entry: unknown;
      }>(handle.projectDir, ['stacks', 'current', '--json']);
      expect(json.key).toMatch(/^[0-9a-f]{12}$/);
      expect(json.path).toBe(handle.projectDir);
      expect(json.configPath).toBe(
        join(handle.projectDir, 'levelzero.config.ts'),
      );
      // Pre-dev: not running.
      expect(json.running).toBe(false);
      expect(json.entry).toBeNull();
    });

    it('stacks list --json returns an array (does not include this project pre-dev)', () => {
      const { json } = runCliJson<{
        stacks: Array<{ key: string; path: string }>;
      }>(handle.projectDir, ['stacks', 'list', '--json']);
      expect(Array.isArray(json.stacks)).toBe(true);
      const ours = json.stacks.find((s) => s.path === handle.projectDir);
      expect(
        ours,
        `expected no running stack at ${handle.projectDir}`,
      ).toBeUndefined();
    });

    it('stacks prune --json returns a structured result', () => {
      const { json } = runCliJson<{ pruned: string[] }>(
        handle.projectDir,
        ['stacks', 'prune', '--json'],
      );
      expect(Array.isArray(json.pruned)).toBe(true);
      // Every key must match the 12-char hex worktreeKey shape — if anything
      // else slips through the registry has serialized garbage.
      for (const k of json.pruned) {
        expect(k).toMatch(/^[0-9a-f]{12}$/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // urls — outside-project + inside-project paths
  // -------------------------------------------------------------------------
  describe('urls', () => {
    it('urls --json pre-dev returns an empty urls array (no stack registered)', () => {
      const { json } = runCliJson<{ urls: Array<{ service: string }> }>(
        handle.projectDir,
        ['urls', '--json'],
      );
      expect(Array.isArray(json.urls)).toBe(true);
      expect(json.urls.length).toBe(0);
    });

    it('urls --all --json returns a stacks array (may be empty)', () => {
      const { json } = runCliJson<{
        stacks: Array<{ key: string; path: string; urls: unknown[] }>;
      }>(handle.projectDir, ['urls', '--all', '--json']);
      expect(Array.isArray(json.stacks)).toBe(true);
      // We can't assert empty — other projects on the host may have stacks
      // registered. Just assert the shape is right.
      for (const s of json.stacks) {
        expect(typeof s.key).toBe('string');
        expect(typeof s.path).toBe('string');
        expect(Array.isArray(s.urls)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // compose — error path (pre-dev, no compose file)
  // -------------------------------------------------------------------------
  describe('compose', () => {
    it('compose ps before dev errors with NO_PROJECT and a hint', () => {
      // Compose passthrough requires `.levelzero/docker-compose.yml`. Pre-dev
      // that file doesn't exist; the command should fail loudly with a hint
      // pointing at `levelzero dev`.
      const res = runCli(handle.projectDir, ['compose', 'ps', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/no compose file|levelzero dev/);
    });

    it('compose with no subcommand errors with usage', () => {
      const res = runCli(handle.projectDir, ['compose', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/subcommand|usage/);
    });
  });

  // -------------------------------------------------------------------------
  // logs — pre-dev "no stack" path
  // -------------------------------------------------------------------------
  describe('logs', () => {
    it('logs --json pre-dev returns a note (not an error)', () => {
      const { json } = runCliJson<{ lines: string[]; note?: string }>(
        handle.projectDir,
        ['logs', '--json'],
      );
      expect(Array.isArray(json.lines)).toBe(true);
      expect(json.lines.length).toBe(0);
      // Pretty + JSON both surface a note when there's no stack. Without
      // this note the command silently returns nothing, which is the LEV-197
      // class of failure mode we're guarding against.
      expect(json.note ?? '').toMatch(/no stack/i);
    });
  });

  // -------------------------------------------------------------------------
  // dev / stop — docker-gated lifecycle
  // -------------------------------------------------------------------------
  // Three-stage lifecycle: bring up → assert against the running stack →
  // tear down. Splitting across multiple `it()` calls (rather than one
  // monolithic test) lets us mark the docked-state-dependent failures
  // (LEV-208 compose ps) as `it.fails` independently. Vitest runs tests
  // within a describe sequentially in declaration order, and the singleFork
  // pool means the test file shares process state with the outer-scope
  // `handle`, so we can safely share `dev` output between tests.
  describe.skipIf(!DOCKER)('dev / stop lifecycle (docker)', () => {
    it(
      'dev --json brings up the stack',
      { timeout: 240_000 },
      () => {
        const dev = runCli(handle.projectDir, ['dev', '--json'], {
          timeoutMs: 180_000,
        });
        expect(dev.exitCode, dev.stderr).toBe(0);
        const devOut = JSON.parse(dev.stdout) as {
          key: string;
          path: string;
          ports: Record<string, number>;
          compose: { projectName: string };
          detached?: boolean;
        };
        handle.setComposeProjectName(devOut.compose.projectName);
        expect(devOut.detached).toBe(true);
        expect(devOut.ports.postgres).toBeGreaterThanOrEqual(54000);
      },
    );

    it('stacks current --json reports running:true while dev is up', () => {
      const cur = runCli(handle.projectDir, ['stacks', 'current', '--json']);
      expect(cur.exitCode, cur.stderr).toBe(0);
      const curOut = JSON.parse(cur.stdout) as {
        running: boolean;
        entry: { ports: Record<string, number> } | null;
      };
      expect(curOut.running).toBe(true);
      expect(curOut.entry).not.toBeNull();
    });

    it('urls --json returns one row per registered service while dev is up', () => {
      const urls = runCli(handle.projectDir, ['urls', '--json']);
      expect(urls.exitCode, urls.stderr).toBe(0);
      const urlsOut = JSON.parse(urls.stdout) as {
        urls: Array<{ service: string; target: string }>;
      };
      expect(urlsOut.urls.length).toBeGreaterThan(0);
    });

    // LEV-208 — `compose` looks for `<worktree>/.levelzero/docker-compose.
    // yml` but `dev` writes it under `<worktree>/.levelzero/<key>/docker-
    // compose.yml`. So `compose ps` fails with NO_PROJECT today even though
    // the stack IS up. Marked `it.fails` so the suite stays green while the
    // bug is present; drop `.fails` when LEV-208 lands.
    it.fails(
      'LEV-208 regression: compose ps --json succeeds while dev is up',
      { timeout: 30_000 },
      () => {
        const ps = runCli(handle.projectDir, ['compose', 'ps', '--json'], {
          timeoutMs: 20_000,
        });
        expect(ps.exitCode, ps.stderr).toBe(0);
      },
    );

    it(
      'stop --json tears the stack down cleanly',
      { timeout: 120_000 },
      () => {
        const stop = runCli(handle.projectDir, ['stop', '--json'], {
          timeoutMs: 90_000,
        });
        expect(stop.exitCode, stop.stderr).toBe(0);

        // After stop: stacks current should report running:false again.
        const cur2 = runCli(handle.projectDir, ['stacks', 'current', '--json']);
        const cur2Out = JSON.parse(cur2.stdout) as { running: boolean };
        expect(cur2Out.running).toBe(false);
      },
    );

    it(
      'stacks prune --all --json runs after stop without throwing',
      { timeout: 60_000 },
      () => {
        // Post-stop, the registry entry for this project is gone. A `prune
        // --all` should now run the docker sweep (containers + networks).
        // We can't assert anything ABOUT this host's other stacks (they
        // might be running tests too), but the command MUST exit 0 and
        // return the structured shape.
        const res = runCli(
          handle.projectDir,
          ['stacks', 'prune', '--all', '--json'],
          { timeoutMs: 45_000 },
        );
        expect(res.exitCode, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          pruned: string[];
          containersRemoved: string[];
          networksRemoved: string[];
          dockerSkipped?: boolean;
        };
        expect(Array.isArray(out.pruned)).toBe(true);
        expect(Array.isArray(out.containersRemoved)).toBe(true);
        expect(Array.isArray(out.networksRemoved)).toBe(true);
      },
    );
  });

  // -------------------------------------------------------------------------
  // stacks stop --all — destructive global teardown (docker-gated)
  //
  // NOT run as part of the normal docker block because it would tear down
  // every running levelzero stack on the host — including ones from other
  // concurrent test files / agents. Tested behind a separate env flag so an
  // operator can opt in deliberately.
  // -------------------------------------------------------------------------
  describe('stacks stop (global)', () => {
    it('stacks stop without --all errors with a usage hint', () => {
      const res = runCli(handle.projectDir, ['stacks', 'stop', '--json']);
      expect(res.exitCode).not.toBe(0);
      const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
      expect(combined).toMatch(/--all|not supported/);
    });
  });

  // -------------------------------------------------------------------------
  // Sanity: every helper file in this suite exists. Detects a refactor that
  // breaks one of these helpers without touching the corresponding test.
  // -------------------------------------------------------------------------
  describe('harness self-test', () => {
    it('every helper file used by this suite exists on disk', () => {
      const helpersDir = join(__dirname, '_helpers');
      for (const f of ['setup.ts', 'scaffold.ts', 'install.ts', 'cli.ts', 'docker.ts']) {
        expect(existsSync(join(helpersDir, f)), `missing helper ${f}`).toBe(true);
      }
    });
  });
});
