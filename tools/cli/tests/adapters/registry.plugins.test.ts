import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../../src/adapters/registry';

/**
 * The plugin loader is exercised through real on-disk fixtures: we write tiny
 * adapter modules into a tmpdir and `dynamic import()` them through the loader.
 * Bundler-mode TS would normally rewrite imports, but at runtime the registry
 * calls `import(absPath)` directly, so vitest happily executes the fixture as
 * an ES module. Each fixture covers one shape-detection branch (portless,
 * auth, orm, ui, browser, backend, frontend, test-runner) plus the override
 * paths (`mod.default`, `mod[name]`, explicit `slot` annotation) and the
 * error cases (bad path, unknown shape).
 */
describe('AdapterRegistry.loadCustomPlugins', () => {
  let pluginsDir: string;
  let registry: AdapterRegistry;

  beforeEach(() => {
    pluginsDir = mkdtempSync(join(tmpdir(), 'lev-plugins-'));
    registry = new AdapterRegistry();
  });

  afterEach(() => {
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  function writePlugin(filename: string, source: string): string {
    const abs = join(pluginsDir, filename);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, source, 'utf8');
    return filename;
  }

  it('loads a portless adapter (detected by register+list+unregister)', async () => {
    const rel = writePlugin(
      'my-portless.mjs',
      `export default {
         name: 'my-portless',
         async available() { return true; },
         async register(input) {},
         async unregister(host) {},
         async list() { return []; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-portless': rel },
    });

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slot).toBe('portless');
    expect(entries[0]!.name).toBe('my-portless');
    expect(registry.listBySlot('portless')).toHaveLength(1);
  });

  it('loads an auth adapter (detected by createUser+signSession)', async () => {
    const rel = writePlugin(
      'my-auth.mjs',
      `export default {
         name: 'my-auth',
         async createUser(ctx, input) { return { id: '1', email: input.email, createdAt: '' }; },
         async signSession(ctx, userId) { return { token: 't', expiresAt: '' }; },
         async inspectSession(ctx, token) { return null; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-auth': rel },
    });

    expect(registry.listBySlot('auth')).toHaveLength(1);
    expect(registry.listBySlot('auth')[0]!.name).toBe('my-auth');
  });

  it('loads an orm adapter (detected by applyMigrations+inspectSchema)', async () => {
    const rel = writePlugin(
      'my-orm.mjs',
      `export default {
         name: 'my-orm',
         async applyMigrations() { return { applied: 0, names: [], output: '' }; },
         async newMigration() { return { path: '', name: '' }; },
         async seed() { return { ok: true, output: '' }; },
         async inspectSchema() { return { tables: {} }; },
         async inspectTable() { return []; },
         async resetDatabase() {},
         async generateClient() {},
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-orm': rel },
    });

    expect(registry.listBySlot('orm')).toHaveLength(1);
  });

  it('loads a ui adapter (detected by add+list, no register)', async () => {
    const rel = writePlugin(
      'my-ui.mjs',
      `export default {
         name: 'my-ui',
         async add() { return { command: '', cwd: '', executed: false, output: '' }; },
         async list() { return { installed: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-ui': rel },
    });

    expect(registry.listBySlot('ui')).toHaveLength(1);
  });

  it('loads a browser adapter (detected by screenshot+diff)', async () => {
    const rel = writePlugin(
      'my-browser.mjs',
      `export default {
         name: 'my-browser',
         async screenshot() { return Buffer.alloc(0); },
         async diff() { return { diffPixels: 0, totalPixels: 0, diffRatio: 0 }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-browser': rel },
    });

    expect(registry.listBySlot('browser')).toHaveLength(1);
  });

  it('loads a backend adapter (detected by extractRoutes)', async () => {
    const rel = writePlugin(
      'my-backend.mjs',
      `export default {
         name: 'my-backend',
         async extractRoutes() { return { generatedAt: '', routes: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-backend': rel },
    });

    expect(registry.listBySlot('backend')).toHaveLength(1);
  });

  it('loads a frontend adapter (detected by generateClient at top level)', async () => {
    const rel = writePlugin(
      'my-frontend.mjs',
      `export default {
         name: 'my-frontend',
         async generateClient() { return { files: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-frontend': rel },
    });

    expect(registry.listBySlot('frontend')).toHaveLength(1);
  });

  it('loads a test-runner adapter (detected by run)', async () => {
    const rel = writePlugin(
      'my-runner.mjs',
      `export default {
         name: 'my-runner',
         async run(input) { return { passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0 }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'my-runner': rel },
    });

    expect(registry.listBySlot('test-runner')).toHaveLength(1);
  });

  it('honors an explicit `slot` annotation on the adapter', async () => {
    // No "shape" of its own — the slot annotation is the only signal.
    const rel = writePlugin(
      'annotated.mjs',
      `export default {
         name: 'annotated',
         slot: 'backend',
         async whatever() {},
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { annotated: rel },
    });

    expect(registry.listBySlot('backend')).toHaveLength(1);
    expect(registry.listBySlot('backend')[0]!.name).toBe('annotated');
  });

  it('uses mod[name] when there is no default export', async () => {
    const rel = writePlugin(
      'named.mjs',
      `export const myNamed = {
         name: 'myNamed',
         async extractRoutes() { return { generatedAt: '', routes: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { myNamed: rel },
    });

    expect(registry.listBySlot('backend')).toHaveLength(1);
    expect(registry.listBySlot('backend')[0]!.name).toBe('myNamed');
  });

  it('falls back to the whole module when neither default nor name match', async () => {
    // Top-level exports define the adapter shape directly.
    const rel = writePlugin(
      'whole-module.mjs',
      `export const name = 'whole-module';
       export async function extractRoutes() { return { generatedAt: '', routes: [] }; }`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { 'whole-module': rel },
    });

    expect(registry.listBySlot('backend')).toHaveLength(1);
  });

  it('loads multiple plugins in one call', async () => {
    const a = writePlugin(
      'a.mjs',
      `export default {
         name: 'a',
         async screenshot() { return Buffer.alloc(0); },
         async diff() { return { diffPixels: 0, totalPixels: 0, diffRatio: 0 }; },
       };`,
    );
    const b = writePlugin(
      'b.mjs',
      `export default {
         name: 'b',
         async extractRoutes() { return { generatedAt: '', routes: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { a, b },
    });

    expect(registry.list()).toHaveLength(2);
    expect(registry.listBySlot('browser')).toHaveLength(1);
    expect(registry.listBySlot('backend')).toHaveLength(1);
  });

  it('resolves paths relative to projectRoot', async () => {
    // Write the plugin into a nested subdir; reference it with a relative path.
    const rel = writePlugin(
      'nested/deep/plugin.mjs',
      `export default {
         name: 'deep',
         async extractRoutes() { return { generatedAt: '', routes: [] }; },
       };`,
    );

    await registry.loadCustomPlugins({
      projectRoot: pluginsDir,
      paths: { deep: rel },
    });

    expect(registry.listBySlot('backend')).toHaveLength(1);
  });

  it('throws including the filepath when the file does not exist', async () => {
    const missing = join(pluginsDir, 'does-not-exist.mjs');
    await expect(
      registry.loadCustomPlugins({
        projectRoot: pluginsDir,
        paths: { missing: 'does-not-exist.mjs' },
      }),
    ).rejects.toThrowError(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws including the filepath when the shape cannot be detected', async () => {
    const rel = writePlugin(
      'unknown.mjs',
      `export default { name: 'unknown', doSomething() {} };`,
    );
    const abs = join(pluginsDir, rel);

    await expect(
      registry.loadCustomPlugins({
        projectRoot: pluginsDir,
        paths: { unknown: rel },
      }),
    ).rejects.toThrowError(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws including the filepath when the adapter is null/undefined', async () => {
    const rel = writePlugin('null.mjs', `export default null;`);
    const abs = join(pluginsDir, rel);

    await expect(
      registry.loadCustomPlugins({
        projectRoot: pluginsDir,
        paths: { 'null-adapter': rel },
      }),
    ).rejects.toThrowError(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
