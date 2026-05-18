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
  // The `backend/hono` adapter lives in `@levelzero/plugin-hono` after
  // LEV-150; `gen client` resolves it from the merged adapter registry, so
  // the project config must declare the plugin or the command has no active
  // backend impl to call.
  // After LEV-174 `gen client` no longer ships an inline
  // `@levelzero/plugin-typed-client` fallback either — both adapters must be
  // declared in the project config. We point at the workspace package
  // sources by absolute path rather than by bare specifier because Bun
  // 1.2.23 segfaults when resolving two `@levelzero/plugin-*` bare
  // specifiers from a tmp-dir project that has no `node_modules` (the
  // ancestor symlink to the workspace `node_modules` walks fine for one
  // bare specifier but not two — likely a Bun resolver bug). The
  // path-form `loadPlugin` branch bypasses `createRequire`/npm resolution
  // entirely.
  writeFileSync(
    join(projectDir, 'levelzero.config.ts'),
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
    env: { ...process.env, LEVELZERO_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: plan-09 commands end-to-end', () => {
  it('gen client extracts Hono routes and writes a typed client file', () => {
    const res = run([
      'gen',
      'client',
      '--api-dir',
      'apps/api',
      '--out',
      'packages/api-client/src',
      '--json',
    ]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Array.isArray(out.generatedFiles)).toBe(true);
    expect(out.generatedFiles.length).toBeGreaterThan(0);

    const generated = join(projectDir, 'packages/api-client/src/index.ts');
    expect(out.generatedFiles).toContain(generated);
    expect(existsSync(generated)).toBe(true);

    const contents = readFileSync(generated, 'utf8');
    // ApiClient interface and the two route fns derived from the Hono app.
    expect(contents).toContain('export interface ApiClient');
    expect(contents).toContain('getApiHealth');
    expect(contents).toContain('postApiUsers');
  }, 30_000);

  it('gen client is a registered command (does not error as UNKNOWN_COMMAND)', () => {
    // Invoke with a project root that has no API entry so the command errors
    // out for a different reason than command-not-found.
    const emptyProj = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p09-empty-')));
    writeFileSync(join(emptyProj, 'levelzero.config.ts'), 'export default {};');
    const res = spawnSync('bun', [BIN, 'gen', 'client', '--json'], {
      cwd: emptyProj,
      env: { ...process.env, LEVELZERO_HOME: homeDir },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    const err = JSON.parse(res.stderr);
    // Must NOT be UNKNOWN_COMMAND — that would mean the command isn't wired.
    expect(err.code).not.toBe('UNKNOWN_COMMAND');
  }, 30_000);
});
