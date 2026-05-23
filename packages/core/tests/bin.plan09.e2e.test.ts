import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = join(__dirname, '..', 'src', 'bin.ts');
// Absolute paths into the workspace's plugin packages — see test setup below
// for why we don't reference them by bare specifier.
const HONO_PLUGIN = join(__dirname, '..', '..', 'plugin-hono', 'src', 'index.ts');
const TYPED_CLIENT_PLUGIN = join(
  __dirname,
  '..',
  '..',
  'plugin-typed-client',
  'src',
  'index.ts',
);

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p09-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p09-home-')));
  // The `backend/hono` adapter lives in `@lich/plugin-hono` after
  // LEV-150; the `api-client` generator (LEV-124 — registered by
  // `@lich/plugin-typed-client`) resolves it from the merged adapter
  // registry, so the project config must declare the plugin or the
  // generator skips.
  // After LEV-174 the typed-client codegen no longer ships an inline
  // `@lich/plugin-typed-client` fallback either — both plugins must
  // be declared in the project config. We point at the workspace package
  // sources by absolute path rather than by bare specifier because Bun
  // 1.2.23 segfaults when resolving two `@lich/plugin-*` bare
  // specifiers from a tmp-dir project that has no `node_modules` (the
  // ancestor symlink to the workspace `node_modules` walks fine for one
  // bare specifier but not two — likely a Bun resolver bug). The
  // path-form `loadPlugin` branch bypasses `createRequire`/npm resolution
  // entirely.
  writeFileSync(
    join(projectDir, 'lich.config.ts'),
    `export default { plugins: [${JSON.stringify(HONO_PLUGIN)}, ${JSON.stringify(TYPED_CLIENT_PLUGIN)}] };`,
  );

  // Tiny Hono app — same pattern as tests/adapters/backend/hono.test.ts.
  const apiSrc = join(projectDir, 'apps', 'api', 'src');
  mkdirSync(apiSrc, { recursive: true });
  writeFileSync(
    join(apiSrc, 'index.ts'),
    `
      import { Hono } from 'hono';
      const app = new Hono();
      app.get('/api/health', (c) => c.json({ ok: true }));
      app.post('/api/users', (c) => c.json({ created: true }, 201));
      export default app;
    `,
  );
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-09 commands end-to-end', () => {
  it('gen --only api-client extracts Hono routes and writes a typed client file', () => {
    // LEV-124: the typed-client codegen is now the `api-client` generator,
    // dispatched through the unified `gen` command. The output shape is
    // {results, ok, skipped, failed} rather than {generatedFiles}; the
    // file list lives at results[0].filesWritten.
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

    const generated = join(projectDir, 'packages/api-client/src/index.ts');
    expect(apiClient?.filesWritten).toContain(generated);
    expect(existsSync(generated)).toBe(true);

    const contents = readFileSync(generated, 'utf8');
    // ApiClient interface and the two route fns derived from the Hono app.
    expect(contents).toContain('export interface ApiClient');
    expect(contents).toContain('getApiHealth');
    expect(contents).toContain('postApiUsers');
  }, 30_000);

  it('gen is a registered command (does not error as UNKNOWN_COMMAND)', () => {
    // Post-LEV-165 + LEV-124 `gen` is only registered when at least one
    // plugin contributes a generator (the inline seed was deleted in the
    // Plan 14 Tier 7 cutover; `gen client` itself was retired in LEV-124).
    // Use the same hono + typed-client pair as the adjacent integration
    // test so the dispatcher actually wires the command — without them the
    // command would surface as UNKNOWN_COMMAND, which the assertion below
    // explicitly forbids.
    const emptyProj = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p09-empty-')));
    writeFileSync(
      join(emptyProj, 'lich.config.ts'),
      `export default { plugins: [${JSON.stringify(HONO_PLUGIN)}, ${JSON.stringify(TYPED_CLIENT_PLUGIN)}] };`,
    );
    // No API entry at apps/api/src/index.ts — the generator should report a
    // fail status (and the command should exit non-zero), but it should NOT
    // be UNKNOWN_COMMAND.
    const res = spawnSync('bun', [BIN, 'gen', '--json'], {
      cwd: emptyProj,
      env: { ...process.env, LICH_HOME: homeDir },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    // Must NOT be UNKNOWN_COMMAND — that would mean the command isn't wired.
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
  }, 30_000);
});
