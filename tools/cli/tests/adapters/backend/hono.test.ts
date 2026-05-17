import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { honoBackendAdapter } from '../../../src/adapters/backend/hono';

let tmp: string;

function writeApiEntry(root: string, source: string): string {
  const apiSrc = join(root, 'apps', 'api', 'src');
  mkdirSync(apiSrc, { recursive: true });
  const entry = join(apiSrc, 'index.ts');
  writeFileSync(entry, source);
  return entry;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-hono-')));
});

describe('honoBackendAdapter', () => {
  it('has the expected name', () => {
    expect(honoBackendAdapter.name).toBe('hono');
  });

  it('extractRoutes returns routes from a Hono app default export', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/api/health', (c) => c.json({ ok: true }));
        app.post('/api/users', (c) => c.json({ created: true }, 201));
        export default app;
      `,
    );

    const manifest = await honoBackendAdapter.extractRoutes(tmp);

    expect(typeof manifest.generatedAt).toBe('string');
    expect(() => new Date(manifest.generatedAt).toISOString()).not.toThrow();

    // Hono registers user-defined routes; ignore framework-internal entries
    // (e.g. ALL '*' middleware wrappers) that aren't user-declared verbs.
    const userRoutes = manifest.routes.map((r) => ({ method: r.method, path: r.path }));
    expect(userRoutes).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/api/health' },
        { method: 'POST', path: '/api/users' },
      ]),
    );
  });

  it('extractRoutes returns an empty routes array for an app with no handlers', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        const app = new Hono();
        export default app;
      `,
    );

    const manifest = await honoBackendAdapter.extractRoutes(tmp);
    expect(manifest.routes).toEqual([]);
    expect(typeof manifest.generatedAt).toBe('string');
  });

  it('extractRoutes throws a useful error when the entry has no default export', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        export const app = new Hono();
      `,
    );

    await expect(honoBackendAdapter.extractRoutes(tmp)).rejects.toThrow(/default export/i);
  });

  it('extractRoutes throws a useful error when the entry file does not exist', async () => {
    await expect(honoBackendAdapter.extractRoutes(tmp)).rejects.toThrow();
  });

  it('extractRoutes preserves dynamic path params (e.g. :id)', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/api/users/:id', (c) => c.json({ id: c.req.param('id') }));
        app.delete('/api/users/:id', (c) => c.body(null, 204));
        export default app;
      `,
    );

    const manifest = await honoBackendAdapter.extractRoutes(tmp);
    const userRoutes = manifest.routes.map((r) => ({ method: r.method, path: r.path }));
    expect(userRoutes).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/api/users/:id' },
        { method: 'DELETE', path: '/api/users/:id' },
      ]),
    );
  });
});
