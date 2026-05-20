/**
 * LEV-198 — Dogfood end-to-end suite.
 *
 * This is the regression-prevention foundation. Every existing "e2e" test in
 * the repo cheats in some way (scaffold into `packages/` to inherit workspace
 * symlinks, mock the install step, etc.). The user has caught 7+ bugs in a
 * single afternoon by running the CLI for real on their machine — all of them
 * passed the existing tests. This suite closes that gap by:
 *
 *   1. Scaffolding into an OS tmpdir (NOT under `packages/`).
 *   2. Running a real `bun install` against `file:` overrides pointing at the
 *      workspace packages. After this step, `node_modules/.bin/levelzero`
 *      exists and the project tree looks like what a `bunx
 *      @levelzero/create-stack-v0 my-app && cd my-app && bun install` user
 *      would see.
 *   3. Exercising the CLI as a real subprocess from the scaffolded project,
 *      not by importing the bin module.
 *   4. Driving the served stack with a real browser (playwright).
 *
 * Phases (per LEV-198 spec):
 *   1. scaffold + install         — non-docker, always runs
 *   2. static checks              — non-docker, always runs
 *   3. stack lifecycle            — docker-gated
 *   4. browser drive              — docker + playwright-gated
 *   5. failure surfaces           — non-docker (except docker-unreachable test)
 *
 * `it.fails(...)` markers are used for known-broken behavior that other open
 * tickets will fix. The test PASSES today (asserting the bug is present);
 * when the bug is fixed, the author removes `.fails` and the assertion
 * becomes a regression check. The inversion is deliberate — see vitest's
 * `it.fails` docs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffoldProject } from './_helpers/scaffold';
import { installDeps } from './_helpers/install';
import { runCli, runCliJson } from './_helpers/cli';
import {
  dockerAvailable,
  dockerComposeDown,
} from './_helpers/docker';
import {
  playwrightAndChromiumAvailable,
  withBrowser,
} from './_helpers/playwright';

/**
 * Both probes evaluated at file-parse time for `describe.skipIf`. The
 * docker probe shells out to `docker network create` then tears it back
 * down (catches address-pool exhaustion that `docker info` alone misses).
 * The playwright/chromium probe walks the playwright registry directory
 * to check the chromium browser binary is present. Both are synchronous
 * so vitest can evaluate them when wiring up the describe tree.
 */
const DOCKER = dockerAvailable();
const PLAYWRIGHT_OK = playwrightAndChromiumAvailable();

const PROJECT_NAME = 'demo';

let tmpdir: string;
let projectDir: string;
let composeProjectName: string | null = null;
/**
 * Snapshot of the scaffolded `package.json` captured BEFORE `installDeps`
 * patches in workspace overrides (and currently a `@levelzero/core` dep —
 * see LEV-205). Phase 1's template-bug regression test reads this so it
 * sees what the user actually gets out of `create-stack-v0`, not the
 * harness-modified file.
 */
let scaffoldedRootPkgJson: string | null = null;

describe('LEV-198 dogfood: scaffold → install → run → drive', () => {
  beforeAll(async () => {
    // Scaffold into an OS tmpdir — explicitly NOT under `packages/`. This is
    // the whole point of LEV-198: if any code path relies on workspace
    // symlinks for `@levelzero/*` resolution, it WILL fail here, and the
    // test should fail loudly so the underlying scaffold/install bug gets
    // fixed instead of getting papered over in CI.
    tmpdir = realpathSync(mkdtempSync(join(osTmpdir(), 'lz-e2e-dogfood-')));
    const { projectDir: dir } = await scaffoldProject({
      tmpdir,
      projectName: PROJECT_NAME,
    });
    projectDir = dir;

    // Snapshot the scaffolded `package.json` BEFORE `installDeps` patches
    // it (see LEV-205 — the harness currently injects `@levelzero/core`
    // because the template doesn't declare it). Phase 1's template-bug
    // regression test asserts on this snapshot.
    scaffoldedRootPkgJson = readFileSync(join(projectDir, 'package.json'), 'utf8');

    // Real `bun install` with `file:` overrides pointing at the local
    // workspace. Throws (with bun's stderr) if install fails.
    await installDeps(projectDir);
  }, 240_000);

  afterAll(async () => {
    // Cleanup is best-effort and aggressive: every step is wrapped in try/
    // catch so a single failure doesn't abort the rest. We're already
    // leaking docker networks on the host (LEV-202); this is where we stop
    // that bleed for the dogfood tier.
    try {
      if (projectDir) runCli(projectDir, ['stop', '--json'], { timeoutMs: 30_000 });
    } catch {
      /* stop is best-effort */
    }
    try {
      if (composeProjectName) dockerComposeDown(composeProjectName);
    } catch {
      /* compose down is best-effort */
    }
    try {
      if (tmpdir) rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      /* tmpdir cleanup is best-effort — vitest's process exit may race */
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 1 — scaffold + install (non-docker, always runs)
  // -------------------------------------------------------------------------
  describe('phase 1: scaffold + install', () => {
    it('scaffolds the canonical v0 project tree into the OS tmpdir', () => {
      expect(projectDir.startsWith(realpathSync(osTmpdir()))).toBe(true);
      expect(existsSync(join(projectDir, 'levelzero.config.ts'))).toBe(true);
      expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
      expect(existsSync(join(projectDir, 'apps', 'api', 'package.json'))).toBe(true);
      expect(existsSync(join(projectDir, 'apps', 'web', 'package.json'))).toBe(true);
      expect(existsSync(join(projectDir, 'prisma', 'schema.prisma'))).toBe(true);
      // `name` substitution made it into both package.json and config.
      const pkg = readFileSync(join(projectDir, 'package.json'), 'utf8');
      expect(pkg).toContain(`"name": "${PROJECT_NAME}"`);
      const cfg = readFileSync(join(projectDir, 'levelzero.config.ts'), 'utf8');
      expect(cfg).toContain(`name: '${PROJECT_NAME}'`);
    });

    it('bun install populated node_modules with the levelzero bin', () => {
      // The install threw if it had failed, so this is a smoke / sentinel
      // check that the `.bin/levelzero` discovery worked.
      expect(
        existsSync(join(projectDir, 'node_modules', '.bin', 'levelzero')),
      ).toBe(true);
    });

    // LEV-205 — `create-stack-v0`'s template `package.json` lists every
    // `@levelzero/plugin-*` but does NOT declare `@levelzero/core` as a
    // direct dep. Bun has no reason to materialize the `levelzero` bin
    // under `node_modules/.bin/` from a transitive, so the documented
    // first-time-user flow (`bunx @levelzero/create-stack-v0 my-app &&
    // cd my-app && bun install && bun run levelzero --help`) breaks with
    // "Script not found 'levelzero'". The e2e harness patches `@levelzero/
    // core: "*"` in before running `bun install` (see install.ts
    // applyWorkspaceOverrides) — that's a workaround, not a fix, so we
    // assert the underlying template bug here against the SNAPSHOT taken
    // BEFORE the harness patch.
    //
    // `it.fails` today (the bug is present); when LEV-205 lands the
    // implementer drops `.fails` AND removes the harness patch.
    it.fails(
      'LEV-205 regression: template package.json declares @levelzero/core as a direct dep',
      () => {
        expect(scaffoldedRootPkgJson).not.toBeNull();
        const pkg = JSON.parse(scaffoldedRootPkgJson!) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const declared =
          !!pkg.dependencies?.['@levelzero/core'] ||
          !!pkg.devDependencies?.['@levelzero/core'];
        expect(declared).toBe(true);
      },
    );

    // Bun hoists every workspace dep to the root `node_modules` in this
    // scaffold — `apps/*/node_modules/` are not created at all (verified by
    // probing a real install of the scaffolded tree, see LEV-198 review
    // notes). Pin both assertions to the hoisted root path; if bun's
    // resolution strategy changes (e.g. it starts using per-app
    // `node_modules` for deduplication conflicts) these will fail loudly
    // and the comment can be revisited.
    it('next is hoisted to the root node_modules', () => {
      expect(
        existsSync(join(projectDir, 'node_modules', '.bin', 'next')),
      ).toBe(true);
    });

    it('@prisma/client is hoisted to the root node_modules', () => {
      expect(
        existsSync(join(projectDir, 'node_modules', '@prisma', 'client')),
      ).toBe(true);
    });

    it('bun run levelzero --help lists the canonical command set', () => {
      const res = runCli(projectDir, ['--help']);
      expect(res.exitCode, res.stderr).toBe(0);
      // Inline commands.
      expect(res.stdout).toContain('dev');
      expect(res.stdout).toContain('stop');
      expect(res.stdout).toContain('doctor');
      // Plugin-contributed commands — these only appear if `loadConfig` +
      // `bootPlugins` actually ran against the real-installed plugin tree.
      expect(res.stdout).toMatch(/^\s+gen\s+/m);
      expect(res.stdout).toContain('db migrate');
      expect(res.stdout).toContain('adapter list');
      expect(res.stdout).toContain('env list');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — static checks (non-docker, always runs)
  // -------------------------------------------------------------------------
  describe('phase 2: static checks', () => {
    it('levelzero doctor --json reports ok (or only docker-skipped)', () => {
      const { json } = runCliJson<{
        ok: boolean;
        checks: Array<{ id: string; status: string; message?: string }>;
      }>(projectDir, ['doctor', '--json']);
      // Either everything is green, OR the only non-ok rows are docker /
      // skipped categories. The "registry warn" channel (stale levelzero
      // networks) is allowed too — it's a warning, not an error.
      const bad = json.checks.filter(
        (c) => c.status !== 'ok' && c.status !== 'warn' && c.status !== 'skipped',
      );
      expect(bad).toEqual([]);
      expect(json.ok).toBe(true);
    });

    it('levelzero adapter list --json shows the v0 active impls', () => {
      const { json } = runCliJson<{
        adapters: Array<{ slot: string; name: string; active: boolean }>;
      }>(projectDir, ['adapter', 'list', '--json']);
      const byKey = new Map(json.adapters.map((a) => [`${a.slot}:${a.name}`, a]));
      expect(byKey.get('orm:prisma')?.active).toBe(true);
      expect(byKey.get('backend:hono')?.active).toBe(true);
      expect(byKey.get('frontend:typed-client')?.active).toBe(true);
      expect(byKey.get('auth:better-auth')?.active).toBe(true);
      expect(byKey.get('ui:shadcn')?.active).toBe(true);
      expect(byKey.get('browser:playwright')?.active).toBe(true);
    });

    it('levelzero env list --json surfaces postgres/hono/next URL sources', () => {
      const { json } = runCliJson<{
        entries: Array<{
          key: string;
          protocol: string | null;
          plugin: string;
        }>;
      }>(projectDir, ['env', 'list', '--json']);
      const byKey = new Map(json.entries.map((e) => [e.key, e]));
      expect(byKey.get('postgres.url')?.protocol).toBe('postgres');
      expect(byKey.get('hono.url')?.protocol).toBe('http');
      expect(byKey.get('next.url')?.protocol).toBe('http');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3 — stack lifecycle (docker-gated)
  // -------------------------------------------------------------------------
  describe.skipIf(!DOCKER)('phase 3: stack lifecycle', () => {
    it(
      'levelzero dev --json brings up the stack detached within 90s',
      { timeout: 180_000 },
      () => {
        const res = runCli(projectDir, ['dev', '--json'], { timeoutMs: 150_000 });
        expect(res.exitCode, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          key: string;
          path: string;
          ports: Record<string, number>;
          containers: string[];
          compose: { projectName: string; file: string };
          detached?: boolean;
          owned?: { pids: Record<string, number> };
        };
        composeProjectName = out.compose.projectName;
        // Postgres gets a host-port allocation in the 54000+ range.
        expect(out.ports.postgres).toBeGreaterThanOrEqual(54000);
        // The api and web services are "owned" — host processes, not in
        // compose. They MUST have allocated ports too (the bug LEV-200 is
        // about them ignoring those ports, but the allocation itself
        // should still happen).
        expect(out.ports['api-http']).toBeGreaterThanOrEqual(54000);
        expect(out.ports['web-http']).toBeGreaterThanOrEqual(54000);
        // LEV-194 — default path is detached, with pid map for owned services.
        expect(out.detached).toBe(true);
        expect(out.owned?.pids).toBeDefined();
        // At least one owned service should have a PID we can verify.
        const pidValues = Object.values(out.owned?.pids ?? {});
        expect(pidValues.length).toBeGreaterThan(0);
        // Compose project name comes back populated regardless of whether
        // any service declares a `container_name` (plugin-postgres doesn't,
        // so `out.containers` is `[]` by design — compose auto-names them).
        expect(out.compose.projectName).toMatch(/^levelzero-[0-9a-f]{12}$/);
      },
    );

    // LEV-200 regression — the api binds to the allocated port via the
    // `API_PORT` env var the hono plugin's `port` EnvSource publishes. Before
    // the fix, the api template hardcoded port 3000 and ignored the
    // allocation, which made this fetch fail (EADDRINUSE when 3000 was
    // taken, or wrong-port when it wasn't). Forward-regression guard.
    it(
      'LEV-200 regression: GET /api/health returns 200 on the allocated api port',
      { timeout: 30_000 },
      async () => {
        // Read the allocated port from .levelzero/state/<key>/env/api.env —
        // the dev runner writes API_URL there with the host-context URL.
        const stateDir = join(projectDir, '.levelzero', 'state');
        const keyDirs = readdirSync(stateDir).filter((d) =>
          /^[0-9a-f]{12}$/.test(d),
        );
        expect(keyDirs.length).toBe(1);
        const apiEnvPath = join(stateDir, keyDirs[0]!, 'env', 'api.env');
        const apiEnv = readFileSync(apiEnvPath, 'utf8');
        const apiUrlLine = apiEnv
          .split('\n')
          .find((l) => l.startsWith('API_URL='));
        expect(apiUrlLine).toBeDefined();
        const apiUrl = apiUrlLine!.replace(/^API_URL=/, '').trim();
        const res = await fetch(`${apiUrl}/api/health`).catch((err) => {
          throw new Error(`fetch ${apiUrl}/api/health failed: ${err.message}`);
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('ok');
      },
    );

    // LEV-204 regression: `levelzero db migrate` used to fail in a fresh
    // scaffold because the template's `prisma.config.ts` imports from
    // `'prisma/config'` but the template `package.json` didn't declare
    // `prisma` as a direct devDep — so bun had no reason to materialize
    // `node_modules/prisma` at the demo root, and Prisma 7's `config`
    // subpath was unresolvable. Adding `prisma: ^7.0.0` to the template
    // root's devDeps is the fix; this test now asserts the forward
    // behavior.
    it(
      'LEV-204 regression: db migrate --json exits 0 in a fresh scaffold',
      { timeout: 120_000 },
      () => {
        const res = runCli(projectDir, ['db', 'migrate', '--json'], {
          timeoutMs: 90_000,
        });
        expect(res.exitCode, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as { ok: boolean };
        expect(out.ok).toBe(true);
      },
    );

    // `db seed` can only succeed after a successful `db migrate` — the
    // seed script needs the schema applied to insert rows. Pre-LEV-204,
    // the migrate step never produced a usable schema, so seed had
    // nothing to write against. Now that LEV-204 is fixed, the
    // migrate → seed chain works end-to-end in a fresh scaffold.
    it(
      'LEV-204 regression: db seed --json exits 0 after migrate in a fresh scaffold',
      { timeout: 120_000 },
      () => {
        const res = runCli(projectDir, ['db', 'seed', '--json'], {
          timeoutMs: 90_000,
        });
        expect(res.exitCode, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as { ok: boolean };
        expect(out.ok).toBe(true);
      },
    );

    it(
      'levelzero gen --json exits 0',
      { timeout: 90_000 },
      () => {
        const res = runCli(
          projectDir,
          ['gen', '--only', 'api-client', '--json'],
          { timeoutMs: 60_000 },
        );
        // We assert the JSON shape rather than just exit code so we catch
        // the LEV-197 class of bug (silent failure with exit 0).
        if (res.exitCode === 0) {
          const out = JSON.parse(res.stdout) as { ok: number };
          expect(typeof out.ok).toBe('number');
        } else {
          // If gen fails it should fail loudly with a useful stderr — that
          // assertion lives in phase 5. Here we just record the failure.
          expect(res.exitCode, `gen failed: ${res.stderr}`).toBe(0);
        }
      },
    );

    it(
      'levelzero stop --json tears the stack down cleanly',
      { timeout: 120_000 },
      () => {
        const res = runCli(projectDir, ['stop', '--json'], { timeoutMs: 90_000 });
        expect(res.exitCode, res.stderr).toBe(0);
        // After stop, `stacks current` should report running:false.
        const cur = runCli(projectDir, ['stacks', 'current', '--json']);
        expect(cur.exitCode, cur.stderr).toBe(0);
        const parsed = JSON.parse(cur.stdout) as { running: boolean };
        expect(parsed.running).toBe(false);
      },
    );

    // LEV-201 regression — after stop, host processes on allocated ports
    // are gone. Should already work; if it doesn't this catches the
    // regression. The api may never have come up (LEV-200), but stop must
    // still kill the bun child process bun spawned (which is bound to
    // SOME port — either 3000 if LEV-200 bug present, or the allocated
    // port if LEV-200 is fixed). Either way, the pid file should be
    // cleaned up.
    it(
      'LEV-201 regression: stop cleans up pid files and tears down host processes',
      { timeout: 90_000 },
      () => {
        const dev = runCli(projectDir, ['dev', '--json'], { timeoutMs: 120_000 });
        expect(dev.exitCode, dev.stderr).toBe(0);
        const devOut = JSON.parse(dev.stdout) as {
          owned?: { pids: Record<string, number>; pidPaths: Record<string, string> };
        };
        // The dev runner reports pids + pidPaths for each owned service.
        // We expect at least api + web to be present — if this map is
        // empty, the rest of the test would be a vacuous pass (the
        // for-loop body never executes). Fail loudly instead.
        const pids = devOut.owned?.pids ?? {};
        const pidPaths = devOut.owned?.pidPaths ?? {};
        expect(
          Object.keys(pids).length,
          'expected at least one owned service pid (api + web) in dev output',
        ).toBeGreaterThan(0);
        expect(
          Object.keys(pidPaths).length,
          'expected pidPaths to mirror pids — runner contract (see runner.ts DetachedRunnerHandle)',
        ).toBeGreaterThan(0);

        const stop = runCli(projectDir, ['stop', '--json'], { timeoutMs: 60_000 });
        expect(stop.exitCode, stop.stderr).toBe(0);

        // For each owned service, the process should be gone (kill -0 fails
        // with ESRCH). Idempotent: we don't care HOW it died, just that
        // it's not running anymore.
        for (const [name, pid] of Object.entries(pids)) {
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch {
            alive = false;
          }
          expect(alive, `owned service ${name} (pid ${pid}) still alive after stop`).toBe(false);
        }

        // After `stop`, every pid file on disk should be removed —
        // `removePidFile` in runner.ts is what keeps the state dir tidy so
        // a subsequent `dev` doesn't see stale pid files from a previous
        // run. Stale pid files were the LEV-201 user-visible symptom.
        for (const [name, pidPath] of Object.entries(pidPaths)) {
          expect(
            existsSync(pidPath),
            `pid file for ${name} still exists at ${pidPath} after stop`,
          ).toBe(false);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Phase 4 — browser drive (docker + playwright + chromium-gated)
  //
  // The describe.skipIf gates on BOTH probes synchronously: docker available
  // AND the playwright package + chromium browser binary both present. If
  // any prereq is missing, the whole phase skips cleanly with no test body
  // executed — so the assertion below correctly fails only when the landing
  // page itself regresses, not when playwright/chromium are missing.
  // -------------------------------------------------------------------------
  describe.skipIf(!DOCKER || !PLAYWRIGHT_OK)('phase 4: browser drive', () => {
    // LEV-195 / LEV-200 — the landing page renders the projectName + an api
    // health badge. Requires (a) `next dev` to bind to its allocated port
    // (LEV-200 — web template's `dev` script now passes `--port "$WEB_PORT"`)
    // and (b) the api to be reachable at `API_URL` for the server-side
    // health check.
    it(
      'LEV-195/200 regression: renders the landing page with title and health badge',
      { timeout: 90_000 },
      async () => {
        // Make sure the stack is up — phase 3 may or may not have stopped it.
        const dev = runCli(projectDir, ['dev', '--json'], { timeoutMs: 120_000 });
        expect(dev.exitCode, dev.stderr).toBe(0);

        // Pull the WEB_URL from the api env file (next's URL). Could also
        // come from `levelzero urls --json`, but the env file is simpler
        // and the `dev` command guarantees it exists.
        const stateDir = join(projectDir, '.levelzero', 'state');
        const keyDirs = readdirSync(stateDir).filter((d) =>
          /^[0-9a-f]{12}$/.test(d),
        );
        expect(keyDirs.length).toBe(1);
        const apiEnvPath = join(stateDir, keyDirs[0]!, 'env', 'api.env');
        const env = readFileSync(apiEnvPath, 'utf8');
        const webUrlLine = env.split('\n').find((l) => l.startsWith('WEB_URL='));
        expect(webUrlLine).toBeDefined();
        const webUrl = webUrlLine!.replace(/^WEB_URL=/, '').trim();

        await withBrowser(webUrl, async (page) => {
          const title = await (page as any).textContent('h1.lz-title');
          expect(title).toContain(PROJECT_NAME);
          // The health badge says "healthy" if the api responded; the page
          // renders server-side via `fetch(API_URL/api/health)`.
          const apiHealth = await (page as any).textContent('.lz-ok, .lz-bad');
          expect(['healthy', 'unreachable']).toContain((apiHealth ?? '').trim());
        });
      },
    );
  });

  // -------------------------------------------------------------------------
  // Phase 5 — failure surfaces (LEV-197 regression target)
  //
  // The premise: every command should fail LOUDLY with an actionable
  // stderr, never silently with exit 0 and an empty body. LEV-197 surfaced
  // a class of bugs where errors got swallowed; these tests are the
  // forward-regression guard.
  // -------------------------------------------------------------------------
  describe('phase 5: failure surfaces', () => {
    it(
      'LEV-197 regression: gen fails loudly when @prisma/client is missing',
      { timeout: 60_000 },
      () => {
        // We intentionally move @prisma/client out of node_modules and run
        // gen with the prisma generator. If the bug is back, gen exits 0
        // with no diagnostic — i.e. our assertion that "stderr mentions
        // prisma" fails. Restoration runs in finally.
        const candidates = [
          join(projectDir, 'apps', 'api', 'node_modules', '@prisma', 'client'),
          join(projectDir, 'node_modules', '@prisma', 'client'),
        ];
        const target = candidates.find((c) => existsSync(c));
        if (!target) {
          // Nothing to move — skip (and document why).
          expect.soft(true, '@prisma/client not found in expected locations').toBe(true);
          return;
        }
        const stash = `${target}.lev198-stash`;
        renameSync(target, stash);
        try {
          const res = runCli(projectDir, ['gen', '--only', 'prisma', '--json'], {
            timeoutMs: 30_000,
          });
          // Must fail loudly — exit non-zero with diagnostic output.
          expect(res.exitCode).not.toBe(0);
          const stderr = res.stderr;
          // The LEV-197 regression target: stderr MUST surface the actual
          // underlying error, not just the opaque "1 generator(s) failed"
          // summary. The real install probe shows the missing-module path
          // produces "Cannot find module 'prisma/config'" (or similar
          // module-resolution error) inside the generator's diagnostics.
          // If this matcher stops matching after a code change, the
          // probable cause is that the inner error got swallowed again
          // (LEV-197 regression) — not that the error string changed.
          expect(stderr).toMatch(/cannot find module|MODULE_NOT_FOUND|ENOENT/i);
          // And stderr MUST NOT be ONLY the opaque summary. The bug
          // LEV-197 fixed was stderr being a bare "gen: N generator(s)
          // failed: <name>" with no underlying cause attached. We
          // therefore strip out every occurrence of that summary phrase
          // and assert the remainder still contains substantive content
          // (a module-resolution error, a path, etc.) — that proves the
          // underlying cause is being surfaced ALONGSIDE the summary,
          // not as a replacement for it.
          const withoutSummary = stderr
            .replace(/\d+ generator\(s\) failed:[^\n"]*/g, '')
            .toLowerCase();
          expect(withoutSummary).toMatch(/cannot find module|module_not_found|enoent/);
        } finally {
          renameSync(stash, target);
        }
      },
    );

    it(
      'LEV-197 regression: dev fails loudly when docker is unreachable',
      { timeout: 30_000 },
      () => {
        // Simulate docker being unreachable by pointing DOCKER_HOST at a
        // bogus address (tcp://127.0.0.1:1 — no daemon listening). The
        // docker CLI's first call (`docker info` / `docker compose`)
        // fails before any compose work runs. Should surface an error
        // within seconds, not hang or silently exit 0. We deliberately
        // do NOT actually stop the host's docker daemon — that would
        // affect concurrent tests on the same host.
        const res = runCli(projectDir, ['dev', '--json'], {
          timeoutMs: 20_000,
          env: { DOCKER_HOST: 'tcp://127.0.0.1:1' },
        });
        // Two acceptable outcomes:
        //   1. Non-zero exit with diagnostic in stderr.
        //   2. The JSON output contains an error field.
        // Both are "loud failure". Silent success (exit 0, no diagnostic)
        // is what we forbid.
        const combined = `${res.stderr}\n${res.stdout}`.toLowerCase();
        const succeededSilently =
          res.exitCode === 0 && !combined.includes('docker') && !combined.includes('error');
        expect(succeededSilently).toBe(false);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Open-bug regression stubs.
  //
  // These tests document the user-reported bugs that are NOT yet fixed.
  // They live here as `it.todo(...)` placeholders so they appear in the
  // suite output as pending; when the underlying tickets land, the
  // maintainer converts them to real `it(...)` assertions.
  //
  // Why not `it.fails`: the underlying behavior requires async signal
  // handling (SIGINT to a `spawn`'d child) that's awkward to drive from
  // vitest reliably. Stubbing here keeps the bugs visible in the test
  // catalogue without producing flaky red CI runs.
  // -------------------------------------------------------------------------
  describe('open-bug regression stubs', () => {
    it.todo('LEV-199 regression: dev SIGINT mid-startup releases the lock');
    it.todo('LEV-203 regression: SIGINT to dev --live tears down postgres container');
  });
});
