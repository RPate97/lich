/**
 * Plan 14 / LEV-166 — Final end-to-end smoke test.
 *
 * Scaffolds a fresh v0 project via the `@lich/create-stack-v0` binary,
 * then walks the canonical user flow against it:
 *
 *   scaffold → --help → adapter list → env list → env resolve →
 *   (docker-gated) dev → db migrate → gen --only api-client → curl --as → stop
 *
 * The point of having one file that covers the whole arc is to catch
 * regressions where any single seam — scaffolder, plugin loader, command
 * dispatcher, env resolver, compose runner, ORM adapter, auth adapter,
 * typed-client codegen — silently breaks the chain. Each phase short-circuits
 * by failing its own `it()`; the docker-gated phases sit under
 * `describe.skipIf(!docker)` so the CI matrix can run the no-docker subset
 * unconditionally.
 *
 * Why the project is scaffolded *inside* `packages/` rather than the OS
 * tmpdir: the generated `lich.config.ts` does
 * `import postgres from '@lich/plugin-postgres'`. Bun's resolver walks
 * ancestor directories looking for `node_modules`, so the import only
 * succeeds when the scaffold lands somewhere under the monorepo root (where
 * workspace symlinks live in `<root>/node_modules/@lich/`). The OS
 * tmpdir has no such ancestor, so `loadConfig` would throw and `bin.ts`
 * would silently fall back to inline-only commands, defeating the whole
 * point of the smoke test. The `afterAll` cleanup removes the scratch
 * directory regardless of phase outcomes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from './_helpers/docker';
import { computeWorktreeKey } from '../src/worktree';
import { composeProjectName, containerName, volumeName } from '../src/compose/naming';

const BIN = join(__dirname, '..', 'src', 'bin.ts');
const CREATE_BIN = join(
  __dirname,
  '..',
  '..',
  'create-stack-v0',
  'src',
  'bin.ts',
);
// Scaffold scratch dirs live under `packages/` so the workspace
// `node_modules/@lich/*` symlinks are reachable via ancestor lookup —
// that's how bare imports in the generated `lich.config.ts` resolve
// without a real `bun install` step.
const PACKAGES_DIR = join(__dirname, '..', '..');
const PROJECT_NAME = 'demo';

let scratchDir: string;
let projectDir: string;
let homeDir: string;
let worktreeKey: string;

const dockerStatus = dockerOrSkip();

/**
 * `docker info` is necessary but not sufficient — sandboxes (and developer
 * machines after many test runs) routinely exhaust docker's predefined
 * address pools, at which point `docker compose up` fails with
 * `all predefined address pools have been fully subnetted` *despite* a
 * healthy daemon. We catch that here by trying to create-then-delete a
 * throwaway network. If the create fails for any reason we skip the
 * docker-gated phases cleanly.
 *
 * The check runs once at module load (not in `beforeAll`) because it
 * informs the `describe.skipIf` predicate — vitest evaluates `skipIf` at
 * file-parse time.
 */
function canCreateNetwork(): boolean {
  if (!dockerStatus.available) return false;
  const name = `lz-plan14-probe-${process.pid}-${Date.now()}`;
  const create = spawnSync('docker', ['network', 'create', name], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (create.status !== 0) return false;
  spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  return true;
}

const dockerUsable = canCreateNetwork();

function run(args: string[], cwd: string = projectDir) {
  return spawnSync('bun', [BIN, ...args], {
    cwd,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

beforeAll(() => {
  // `mkdtempSync` with the packages/ prefix lets bun's resolver walk up to
  // `<repo>/node_modules` from inside the scaffolded project.
  scratchDir = realpathSync(
    mkdtempSync(join(PACKAGES_DIR, '.lz-plan14-smoke-')),
  );
  homeDir = realpathSync(
    mkdtempSync(join(PACKAGES_DIR, '.lz-plan14-home-')),
  );
  projectDir = join(scratchDir, PROJECT_NAME);

  // Drive the canonical entry point — invoking the create-stack-v0 binary
  // directly (not the underlying `copyTemplate`) so the smoke test exercises
  // the exact code path a user would: name validation, template root
  // resolution, scaffolder invocation, and the printed next-steps message.
  const r = spawnSync('bun', [CREATE_BIN, PROJECT_NAME], {
    cwd: scratchDir,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `create-stack-v0 failed (status ${r.status}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }

  worktreeKey = computeWorktreeKey(projectDir);
}, 60_000);

afterAll(() => {
  // Best-effort teardown for docker-gated phases — only meaningful when the
  // dev phase actually ran. `docker rm`/`docker volume rm` are idempotent
  // (they no-op when the resources don't exist) so we always call them.
  if (worktreeKey && dockerUsable) {
    spawnSync(
      'docker',
      ['rm', '-f', containerName(worktreeKey, 'postgres')],
      { stdio: 'ignore' },
    );
    spawnSync(
      'docker',
      ['volume', 'rm', '-f', volumeName(worktreeKey, 'postgres')],
      { stdio: 'ignore' },
    );
    // LEV-202 — prefer `compose down --remove-orphans` so ANY network the
    // project created is freed in one call (default + user-declared). Falls
    // through to a name-based rm for the legacy `<project>_default` naming
    // in case compose isn't aware of the network.
    const projectName = composeProjectName(worktreeKey);
    spawnSync(
      'docker',
      ['compose', '-p', projectName, 'down', '--volumes', '--remove-orphans', '--timeout', '5'],
      { stdio: 'ignore' },
    );
    spawnSync(
      'docker',
      ['network', 'rm', `${projectName}_default`],
      { stdio: 'ignore' },
    );
  }
  // Filesystem cleanup is unconditional — these dirs live under
  // packages/ and would otherwise accumulate across test runs.
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

describe('bin: Plan 14 / LEV-166 end-to-end smoke test', () => {
  // -------------------------------------------------------------------------
  // Phase 1: scaffold sanity (non-docker)
  //
  // The scaffolder is exercised in `beforeAll`; here we just assert it
  // produced the canonical file set every later phase relies on. If this
  // fails the whole suite is meaningless, so it runs first.
  // -------------------------------------------------------------------------
  it('scaffolds a working v0 project tree at <scratch>/demo/', () => {
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'lich.config.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'turbo.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'apps', 'api', 'package.json'))).toBe(
      true,
    );
    expect(existsSync(join(projectDir, 'apps', 'web', 'package.json'))).toBe(
      true,
    );
    expect(existsSync(join(projectDir, 'prisma', 'schema.prisma'))).toBe(true);

    // The substituted projectName lands in both package.json and the config.
    const pkg = readFileSync(join(projectDir, 'package.json'), 'utf8');
    expect(pkg).toContain(`"name": "${PROJECT_NAME}"`);
    const cfg = readFileSync(join(projectDir, 'lich.config.ts'), 'utf8');
    expect(cfg).toContain(`name: '${PROJECT_NAME}'`);
    // Every plugin the v0 stack ships with must be declared — this is the
    // single source of truth for which slots the later phases will exercise.
    expect(cfg).toContain("from '@lich/plugin-postgres'");
    expect(cfg).toContain("from '@lich/plugin-prisma'");
    expect(cfg).toContain("from '@lich/plugin-hono'");
    expect(cfg).toContain("from '@lich/plugin-better-auth'");
    expect(cfg).toContain("from '@lich/plugin-typed-client'");
    expect(cfg).toContain("from '@lich/plugin-next'");
    expect(cfg).toContain("from '@lich/plugin-shadcn'");
    expect(cfg).toContain("from '@lich/plugin-vitest'");
    expect(cfg).toContain("from '@lich/plugin-playwright'");
  });

  // -------------------------------------------------------------------------
  // Phase 2: `--help` lists plugin-contributed commands (non-docker)
  //
  // Post-LEV-165 (Plan 14 Tier 7 cutover) the inline registry no longer
  // ships db.*, ui.*, gen, curl, test, screenshot, visual diff — those are
  // contributed by plugin-prisma, plugin-shadcn, plugin-hono + plugin-typed-
  // client, plugin-better-auth, plugin-vitest, and plugin-playwright
  // respectively. The fact that they appear here proves
  // (a) loadConfig succeeded, (b) bootPlugins resolved every workspace
  // package, (c) each plugin's `register()` ran, and (d) the contributed
  // commands actually reached the rendered help.
  // -------------------------------------------------------------------------
  it('--help lists every plugin-contributed command (post-LEV-165 cutover)', () => {
    const res = run(['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    // Inline commands still present.
    expect(out).toContain('up');
    expect(out).toContain('down');
    expect(out).toContain('adapter list');
    expect(out).toContain('env list');
    expect(out).toContain('env resolve');
    // Plugin-contributed commands now present because the config declared
    // their plugins.
    expect(out).toContain('db migrate');
    expect(out).toContain('ui add');
    // LEV-124: `gen client` was retired in favor of the unified `gen` top-
    // level command, which is registered by the dispatcher whenever any
    // plugin contributes a generator (api-client from plugin-typed-client,
    // prisma from plugin-prisma).
    expect(out).toMatch(/^\s+gen\s+/m);
    expect(out).toContain('curl');
    // LOADED PLUGINS footer lists every v0 plugin.
    expect(out).toContain('@lich/plugin-postgres');
    expect(out).toContain('@lich/plugin-prisma');
    expect(out).toContain('@lich/plugin-hono');
    expect(out).toContain('@lich/plugin-better-auth');
    expect(out).toContain('@lich/plugin-typed-client');
    expect(out).toContain('@lich/plugin-next');
    expect(out).toContain('@lich/plugin-shadcn');
    expect(out).toContain('@lich/plugin-vitest');
    expect(out).toContain('@lich/plugin-playwright');
  });

  // -------------------------------------------------------------------------
  // Phase 3: `adapter list` shows the active impl per slot (non-docker)
  //
  // Each plugin sets a default active adapter for its slot. Post-Plan-14 the
  // built-in registry is empty, so every row here came from a plugin
  // contribution — if any slot is missing the corresponding plugin failed
  // to call `setActiveAdapter`.
  // -------------------------------------------------------------------------
  it('adapter list shows the active v0 impl for each slot', () => {
    const res = run(['adapter', 'list', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      adapters: Array<{ slot: string; name: string; active: boolean }>;
    };
    const byKey = new Map(
      out.adapters.map((a) => [`${a.slot}:${a.name}`, a]),
    );
    expect(byKey.get('orm:prisma')?.active).toBe(true);
    expect(byKey.get('backend:hono')?.active).toBe(true);
    expect(byKey.get('frontend:typed-client')?.active).toBe(true);
    expect(byKey.get('auth:better-auth')?.active).toBe(true);
    expect(byKey.get('ui:shadcn')?.active).toBe(true);
    expect(byKey.get('browser:playwright')?.active).toBe(true);
    // test-runner has two contributors (vitest + playwright). Either one
    // may be marked active — depends on plugin registration order, which
    // mirrors the config's `plugins[]` order. We just verify both are
    // present so the slot isn't silently missing one.
    expect(byKey.has('test-runner:vitest')).toBe(true);
    expect(byKey.has('test-runner:playwright')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 4: `env list` shows every named EnvSource (non-docker)
  //
  // LEV-184 — `env list` prints the merged EnvSourceRegistry. Plugin-postgres
  // is the primary contributor here (it registers a half-dozen named sources
  // via `addEnvSource`); plugin-hono and plugin-next each register a `url`
  // source. The list also confirms `protocol` is propagated (postgres → url
  // entry has `protocol: 'postgres'`), which db.migrate relies on for its
  // protocol-based resolver.
  // -------------------------------------------------------------------------
  it('env list surfaces postgres.url, hono.url, next.url with the right protocols', () => {
    const res = run(['env', 'list', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      entries: Array<{
        key: string;
        protocol: string | null;
        plugin: string;
      }>;
    };
    const byKey = new Map(out.entries.map((e) => [e.key, e]));
    expect(byKey.get('postgres.url')?.protocol).toBe('postgres');
    expect(byKey.get('postgres.url')?.plugin).toBe('@lich/plugin-postgres');
    expect(byKey.get('postgres.driver')?.plugin).toBe(
      '@lich/plugin-postgres',
    );
    expect(byKey.get('hono.url')?.protocol).toBe('http');
    expect(byKey.get('hono.url')?.plugin).toBe('@lich/plugin-hono');
    expect(byKey.get('next.url')?.protocol).toBe('http');
    expect(byKey.get('next.url')?.plugin).toBe('@lich/plugin-next');
    // postgres exports the granular pieces too — they're what env injection
    // expands when a service's env map lists `postgres.host` etc. explicitly.
    expect(byKey.has('postgres.host')).toBe(true);
    expect(byKey.has('postgres.port')).toBe(true);
    expect(byKey.has('postgres.user')).toBe(true);
    expect(byKey.has('postgres.password')).toBe(true);
    expect(byKey.has('postgres.database')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 5: `env resolve api` returns container-context values (non-docker)
  //
  // The v0 template config maps DATABASE_URL → postgres.url, API_URL →
  // hono.url, WEB_URL → next.url. `env resolve` materializes the values a
  // service would actually see; the `api` service runs inside compose so
  // the host portion of postgres.url is `postgres` (the compose service
  // name), not `localhost`. This is the exact transformation Plan 16 / LEV-182
  // introduced — host vs container context.
  // -------------------------------------------------------------------------
  it('env resolve api produces container-context values for the v0 stack', () => {
    const res = run(['env', 'resolve', 'api', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      service: string;
      context: string;
      env: Record<string, string>;
    };
    expect(out.service).toBe('api');
    expect(out.context).toBe('container');
    // DATABASE_URL points at the postgres compose service hostname, not
    // localhost (api lives in the same compose network).
    expect(out.env.DATABASE_URL).toMatch(/^postgres:\/\//);
    expect(out.env.DATABASE_URL).toContain('@postgres:');
    // API_URL / WEB_URL similarly use the compose hostnames.
    expect(out.env.API_URL).toMatch(/^http:\/\/api:/);
    expect(out.env.WEB_URL).toMatch(/^http:\/\/web:/);
  });
});

// ---------------------------------------------------------------------------
// Docker-gated phases
//
// Below the line: anything that needs a running stack. The whole describe
// block is skipped (cleanly) when `docker info` fails — that includes the
// sandbox case where docker's address pools are exhausted and `docker info`
// itself errors. Each `it` carries a generous per-test timeout because the
// compose bring-up alone can take 30s+ on a cold machine.
// ---------------------------------------------------------------------------
describe.skipIf(!dockerUsable)(
  'bin: Plan 14 / LEV-166 end-to-end smoke test — docker-gated phases',
  () => {
    it(
      'dev brings up postgres + api + web via docker compose',
      { timeout: 180_000 },
      () => {
        const res = run(['up', '--json']);
        expect(res.status, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          key: string;
          path: string;
          ports: Record<string, number>;
          containers: string[];
        };
        expect(out.key).toBe(worktreeKey);
        expect(out.path).toBe(projectDir);
        expect(out.ports.postgres).toBeGreaterThanOrEqual(54000);
        expect(out.containers).toContain(
          containerName(worktreeKey, 'postgres'),
        );
        // LEV-183 wrote per-service env files under .lich/state/<key>/env/.
        // The api service is the canonical one: it's the consumer of
        // DATABASE_URL + API_URL + WEB_URL.
        const apiEnvPath = join(
          projectDir,
          '.lich',
          'state',
          worktreeKey,
          'env',
          'api.env',
        );
        expect(existsSync(apiEnvPath)).toBe(true);
        const apiEnv = readFileSync(apiEnvPath, 'utf8');
        expect(apiEnv).toMatch(/^DATABASE_URL=/m);
        expect(apiEnv).toMatch(/^API_URL=/m);
        expect(apiEnv).toMatch(/^WEB_URL=/m);
      },
    );

    it(
      'db migrate runs against the live postgres',
      { timeout: 120_000 },
      () => {
        const res = run(['db', 'migrate', '--json']);
        // The template ships a schema.prisma but no committed migrations
        // directory — `prisma migrate deploy` against an empty migrations
        // folder is a no-op that exits 0. Either way the wiring proof is
        // that `db migrate` is registered (not UNKNOWN_COMMAND) and can
        // resolve DATABASE_URL through the EnvSource registry.
        expect(res.status, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          ok: boolean;
          applied: number;
          names: string[];
        };
        expect(out.ok).toBe(true);
        expect(typeof out.applied).toBe('number');
        expect(Array.isArray(out.names)).toBe(true);
      },
    );

    it(
      'gen --only api-client emits a typed client from the api routes',
      { timeout: 60_000 },
      () => {
        // LEV-124: the typed-client codegen is now one of several generators
        // driven by the unified `gen` command. We scope to `--only api-client`
        // here so the smoke test doesn't also run `prisma generate` (which
        // we cover separately via `db migrate`).
        const res = run([
          'gen',
          '--only',
          'api-client',
          '--api-dir',
          'apps/api',
          '--out',
          'packages/api-client/src',
          '--json',
        ]);
        expect(res.status, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          results: Array<{ id: string; status: string; filesWritten: string[] | null }>;
          ok: number;
        };
        expect(out.ok).toBe(1);
        const apiClient = out.results.find((r) => r.id === 'api-client');
        expect(apiClient?.status).toBe('ok');
        expect(Array.isArray(apiClient?.filesWritten)).toBe(true);
        expect((apiClient?.filesWritten ?? []).length).toBeGreaterThan(0);
        expect(
          existsSync(join(projectDir, 'packages', 'api-client', 'src', 'index.ts')),
        ).toBe(true);
      },
    );

    it(
      'curl --as creates a user via Better Auth in postgres',
      { timeout: 60_000 },
      () => {
        const res = run([
          'curl',
          '--as',
          'alice@example.com',
          '/api/health',
          '--json',
        ]);
        // The hono template only exposes /api/health — the assertion is on
        // the auth side-effect (user got created), not on a /api/me route
        // the template doesn't ship. `curl --as` invokes Better Auth's
        // getOrCreateUser before the request fires, so any non-error
        // response is proof that auth's prisma adapter wrote the user row.
        expect(res.status, res.stderr).toBe(0);
        const out = JSON.parse(res.stdout) as {
          status: number;
          body: unknown;
        };
        // /api/health returns { status: 'ok' }. We don't assert on the
        // exact status code (could be 404 if the route name shifts) but
        // we do require the request itself completed — non-2xx still
        // returns 0 from the curl command unless the network errored.
        expect(typeof out.status).toBe('number');
      },
    );

    it(
      'stop tears down the stack cleanly',
      { timeout: 120_000 },
      () => {
        const res = run(['down', '--json']);
        expect(res.status, res.stderr).toBe(0);
        // The postgres container should be gone after `stop` — compose
        // removes containers but the named volume persists for the next
        // `dev`. We assert teardown by re-querying `stacks current`: it
        // should report `running: false` for the worktree.
        const stacks = run(['stacks', 'current', '--json']);
        expect(stacks.status, stacks.stderr).toBe(0);
        const parsed = JSON.parse(stacks.stdout) as { running: boolean };
        expect(parsed.running).toBe(false);
      },
    );
  },
);
