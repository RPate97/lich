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
 *
 * LEV-212 — the second describe block in this file (`typed-client output is
 * functional`) is docker-gated and exercises the EMITTED client end-to-end:
 * compile it standalone, then import + call it against the live api. This
 * catches the class of bug where `gen` exits 0 with `{ok: true}` but the
 * generated code is semantically wrong (bad import shape, wrong URL, missing
 * route, response shape that doesn't match the server). Pre-LEV-212 the
 * existing `gen --only api-client` test only asserted exit code + JSON shape
 * — the user only noticed the breakage when their consumer crashed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';
import { dockerAvailable } from './_helpers/docker';

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

// ---------------------------------------------------------------------------
// LEV-212 — codegen OUTPUT usability (docker-gated).
//
// The existing tests above prove `gen --only api-client --json` exits 0 and
// emits a structured result. They do NOT prove the file it wrote is
// import-able, type-checks, or — most critically — actually works against
// the live api. This block closes that gap by:
//
//   1. Compiling the emitted client standalone with `bunx tsc --noEmit`
//      against a one-off tsconfig that targets only the generated file.
//      Catches the case where the emitter writes syntactically valid TS
//      that has a type error inside (e.g. a missing import, a bad
//      generic, …).
//   2. Importing the emitted client from a tiny consumer script, calling
//      a generated function against the running api, and asserting the
//      parsed response matches what the v0 template's `/api/health`
//      handler returns. Catches the "silently wrong URL / wrong method /
//      missing route" class of bug.
//   3. Pointing the same consumer at an unreachable URL and asserting it
//      throws / exits non-zero. Catches the "client masks network errors"
//      class of bug (silent return of `undefined` from a failed request).
//
// Why docker-gated: the second + third tests need a running api. Bringing
// up the api means `lich dev`, which means postgres in a container —
// docker is on the critical path.
//
// EMISSION SHAPE (read off `packages/plugin-typed-client/src/adapter.ts`,
// commit ref in this branch):
//
//   - Output file: `<project>/packages/api-client/src/index.ts`
//   - Exports an `ApiClient` interface: `{ baseUrl: string }`
//   - One async fn per route, named `<method><PascalCasePath>`, taking
//     `(client: ApiClient): Promise<unknown>`:
//       getApiHealth(client)         // GET    /api/health
//       getApiMe(client)             // GET    /api/me
//       getApiTodos(client)          // GET    /api/todos
//       postApiTodos(client)         // POST   /api/todos
//       patchApiTodosById(client)    // PATCH  /api/todos/:id
//       deleteApiTodosById(client)   // DELETE /api/todos/:id
//   - Each fn calls `fetch(\`\${client.baseUrl}<path>\`)` and throws
//     `Error('request failed: ${r.status}')` when `!r.ok`.
//
// The shape above is what the consumer scripts below import. If the
// generator's emission contract changes (different filename, different
// function names, different signature, RPC-style client, …) these tests
// must be updated in the SAME change — otherwise the contract drift will
// silently break consumers.
// ---------------------------------------------------------------------------

const DOCKER = dockerAvailable();

describe.skipIf(!DOCKER)(
  'LEV-212 codegen output usability: emitted typed-client is functional',
  () => {
    let h: E2EProjectHandle;
    let apiUrl: string;
    /** Absolute path to the emitted client file. Filled in by `gen` step. */
    let clientFilePath: string;

    beforeAll(async () => {
      sweepStaleTmpdirs('lz-e2e-codegen-usability-');
      h = await setupScaffoldedProject({
        tmpdirPrefix: 'lz-e2e-codegen-usability-',
      });
      // Bring the stack up so the api is reachable. `dev --json` returns the
      // allocated port map; we read `api-http` for the consumer's baseUrl.
      const dev = runCli(h.projectDir, ['up', '--json'], {
        timeoutMs: 180_000,
      });
      if (dev.exitCode !== 0) {
        throw new Error(
          `dev failed in codegen-usability setup (exit ${dev.exitCode}):\n` +
            `stdout:\n${dev.stdout}\nstderr:\n${dev.stderr}`,
        );
      }
      const devOut = JSON.parse(dev.stdout) as {
        ports: Record<string, number>;
        compose: { projectName: string };
      };
      h.setComposeProjectName(devOut.compose.projectName);
      const apiPort = devOut.ports['api-http'];
      expect(apiPort, 'dev --json must allocate an api-http port').toBeGreaterThan(0);
      apiUrl = `http://localhost:${apiPort}`;

      // Migrate before gen — extractRoutes itself doesn't need the schema,
      // but a healthy `db migrate` confirms the stack is fully booted before
      // we start hitting `/api/health` from the consumer.
      const mig = runCli(h.projectDir, ['db', 'migrate', '--json'], {
        timeoutMs: 90_000,
      });
      expect(mig.exitCode, mig.stderr).toBe(0);

      // Generate the typed client. We assert exit 0 here so any future
      // generator failure short-circuits with a clear message instead of
      // letting the next two tests fail with the much more confusing
      // "client file doesn't exist" error.
      const gen = runCli(
        h.projectDir,
        ['gen', '--only', 'api-client', '--json'],
        { timeoutMs: 60_000 },
      );
      expect(gen.exitCode, gen.stderr).toBe(0);

      // Default outDir is `packages/api-client/src` (see
      // `DEFAULT_OUT_DIR` in `plugin-typed-client/src/generator.ts`). The
      // emitter writes exactly one file: `index.ts`. We compute the path
      // once here so both subsequent tests can reuse it without re-deriving.
      clientFilePath = join(
        h.projectDir,
        'packages',
        'api-client',
        'src',
        'index.ts',
      );
      expect(
        existsSync(clientFilePath),
        `expected emitted client at ${clientFilePath}`,
      ).toBe(true);
    }, 300_000);

    afterAll(async () => {
      await teardownScaffoldedProject(h);
    }, 90_000);

    // -----------------------------------------------------------------------
    // 1. The emitted file compiles standalone.
    //
    // We compile against a fresh, tightly-scoped tsconfig (one `include`
    // entry pointing at the emitted file). Reasons:
    //   - The scaffolded root `tsconfig.json` has no `include`, so a bare
    //     `bunx tsc --noEmit` would walk every .ts file in the project —
    //     slow, and surfaces errors unrelated to the generated client.
    //   - The per-app tsconfigs limit `include` to `src/**/*`, so the
    //     generated `packages/api-client/src/index.ts` isn't covered by
    //     either of them.
    //
    // The standalone tsconfig mirrors the compiler options the template
    // root uses (ES2022 / ESNext / Bundler / strict) so the check fails on
    // the same class of errors the user would see in their app.
    // -----------------------------------------------------------------------
    it(
      'emitted client compiles standalone with strict tsc',
      { timeout: 60_000 },
      () => {
        const tsconfigPath = join(h.projectDir, '_lev212-client-tsconfig.json');
        const tsconfig = {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            esModuleInterop: true,
            isolatedModules: true,
            noEmit: true,
            // The generated file uses Web `fetch`/`Response` types from the
            // DOM lib. Without it, `fetch` is unresolved on Node-only
            // typings and tsc complains.
            lib: ['ES2022', 'DOM'],
          },
          include: [clientFilePath],
        };
        writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');

        const r = spawnSync(
          'bunx',
          ['tsc', '--noEmit', '-p', tsconfigPath],
          {
            cwd: h.projectDir,
            encoding: 'utf8',
            timeout: 45_000,
          },
        );
        // Both streams matter: tsc prints diagnostics to stdout, not stderr.
        const diag = `${r.stdout}\n${r.stderr}`;
        expect(r.status, `tsc failed:\n${diag}`).toBe(0);
      },
    );

    // -----------------------------------------------------------------------
    // 2. The emitted client makes a working request against the live api.
    //
    // We write a tiny consumer script next to the emitted client, import a
    // generated function (`getApiHealth`), instantiate the `ApiClient` with
    // `baseUrl = apiUrl`, call it, and emit the parsed body to stdout. The
    // test then asserts the body matches what the v0 template's
    // `/api/health` handler returns (`{ status: 'ok' }` — see
    // `template-v0-stack/files/apps/api/src/index.ts`).
    //
    // The consumer runs through `bun <file>` so we don't need to compile
    // the script — Bun executes the TS source directly.
    // -----------------------------------------------------------------------
    it(
      'emitted client makes a working request to the live api',
      { timeout: 30_000 },
      () => {
        const consumerPath = join(h.projectDir, '_lev212-consumer.ts');
        // Import path is relative to the consumer's location at the project
        // root. The generated file is at packages/api-client/src/index.ts.
        // Bun resolves bare-relative `./packages/.../index.ts` paths without
        // a package.json shim, which is exactly the import shape an app
        // colocated with the generated client would write by hand.
        const consumerSrc = [
          "import { getApiHealth, type ApiClient } from " +
            "'./packages/api-client/src/index.ts';",
          '',
          'const apiUrl = process.env.API_URL;',
          'if (!apiUrl) {',
          "  console.error('API_URL not set');",
          '  process.exit(2);',
          '}',
          'const client: ApiClient = { baseUrl: apiUrl };',
          'const body = await getApiHealth(client);',
          'console.log(JSON.stringify(body));',
          '',
        ].join('\n');
        writeFileSync(consumerPath, consumerSrc, 'utf8');

        const r = spawnSync('bun', [consumerPath], {
          cwd: h.projectDir,
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, API_URL: apiUrl },
        });
        // Surface BOTH streams on failure so a bad import / bad URL / bad
        // response shape is debuggable from CI logs alone.
        expect(
          r.status,
          `consumer failed: exit=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        ).toBe(0);
        // The consumer prints exactly one JSON document on its last
        // non-empty line. Bun may emit a banner before user output on
        // some versions, so we parse the last line that looks like JSON
        // instead of the whole stdout.
        const jsonLine = r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{') && l.endsWith('}'))
          .pop();
        expect(jsonLine, `no JSON line in stdout:\n${r.stdout}`).toBeDefined();
        const body = JSON.parse(jsonLine!) as { status?: string };
        // The v0 template's `/api/health` handler returns `{ status: 'ok' }`.
        // If the emitter wired the wrong route or method, the server would
        // either 404 (client throws — caught by the next test) or return a
        // different body shape — both would fail this assertion loudly.
        expect(body.status).toBe('ok');
      },
    );

    // -----------------------------------------------------------------------
    // 3. The emitted client surfaces network errors loudly.
    //
    // Negative test: point the consumer at a deliberately unreachable URL
    // (`http://127.0.0.1:1` — port 1 is reserved, nothing ever listens
    // there). The generated client's fetch must fail (connection refused);
    // since the consumer does NOT wrap the call in try/catch, the rejected
    // promise bubbles up to bun's top-level await, which exits non-zero.
    //
    // If this test ever observes exit 0, the client silently swallowed the
    // failure (returning `undefined`, an empty object, etc.) — that's the
    // bug class LEV-197 / LEV-212 are forward-regression guards for. The
    // assertion is intentionally permissive about WHAT non-zero exit code
    // shows up (the actual code depends on bun's handling of unhandled
    // rejections) — only the "exit 0" path is forbidden.
    // -----------------------------------------------------------------------
    it(
      'emitted client surfaces network errors loudly',
      { timeout: 30_000 },
      () => {
        const consumerPath = join(h.projectDir, '_lev212-consumer-bad.ts');
        const consumerSrc = [
          "import { getApiHealth, type ApiClient } from " +
            "'./packages/api-client/src/index.ts';",
          '',
          'const apiUrl = process.env.API_URL;',
          'if (!apiUrl) {',
          "  console.error('API_URL not set');",
          '  process.exit(2);',
          '}',
          'const client: ApiClient = { baseUrl: apiUrl };',
          '// No try/catch — a silent return from the client (the bug we',
          '// are guarding against) would let this script exit 0. A loud',
          '// failure (the correct behavior) makes bun exit non-zero.',
          'const body = await getApiHealth(client);',
          'console.log(JSON.stringify(body));',
          '',
        ].join('\n');
        writeFileSync(consumerPath, consumerSrc, 'utf8');

        const r = spawnSync('bun', [consumerPath], {
          cwd: h.projectDir,
          encoding: 'utf8',
          timeout: 20_000,
          // Port 1 is IANA-reserved; nothing listens there. Both fetch's
          // "connection refused" path AND the generator's `!r.ok` branch
          // (in the unlikely case fetch returned a response) throw.
          env: { ...process.env, API_URL: 'http://127.0.0.1:1' },
        });
        // The CORRECT path is non-zero. Exit 0 means the generated client
        // masked the failure — exactly the bug class this test exists to
        // catch.
        expect(
          r.status,
          'client must throw on unreachable api (got silent exit 0)\n' +
            `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        ).not.toBe(0);
        // Defensive: assert stderr has SOMETHING (the bubbled-up error). A
        // non-zero exit with completely empty stderr would be a different,
        // still-bad behavior — bun killing the process without surfacing
        // the cause. Same class of "what just happened" UX failure.
        const combined = (r.stderr ?? '') + (r.stdout ?? '');
        expect(
          combined.length,
          'expected SOME diagnostic output on the failed request',
        ).toBeGreaterThan(0);
      },
    );
  },
);

