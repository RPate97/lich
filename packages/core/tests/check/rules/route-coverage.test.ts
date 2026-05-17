import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeCoverageRule } from '../../../src/check/rules/route-coverage';

let tmp: string;

function writeApiEntry(root: string, source: string): void {
  const apiSrc = join(root, 'apps', 'api', 'src');
  mkdirSync(apiSrc, { recursive: true });
  writeFileSync(join(apiSrc, 'index.ts'), source);
}

function writeIntegrationTest(
  root: string,
  filename: string,
  source: string,
): void {
  const dir = join(root, 'tests', 'integration');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), source);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-route-cov-')));
});

describe('routeCoverageRule', () => {
  it('has the expected id and description', () => {
    expect(routeCoverageRule.id).toBe('route-coverage');
    expect(routeCoverageRule.describe).toMatch(/integration test/i);
  });

  it('returns skip when the Hono app entry is missing', async () => {
    const result = await routeCoverageRule.check({ projectRoot: tmp });
    expect(result.status).toBe('skip');
    expect(result.message).toMatch(/no hono app/i);
  });

  it('fails listing uncovered routes when only some routes have integration tests', async () => {
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
    writeIntegrationTest(
      tmp,
      'health.test.ts',
      `
        import { describe, it } from 'vitest';
        describe('health', () => {
          it('GETs /api/health', () => {});
        });
      `,
    );

    const result = await routeCoverageRule.check({ projectRoot: tmp });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('/api/users');
    expect(result.message).not.toContain('/api/health');
  });

  it('passes when every route has at least one matching integration test', async () => {
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
    writeIntegrationTest(
      tmp,
      'health.test.ts',
      `
        import { describe, it } from 'vitest';
        describe('health', () => {
          it('GETs /api/health', () => {});
        });
      `,
    );
    writeIntegrationTest(
      tmp,
      'users.test.ts',
      `
        import { describe, it } from 'vitest';
        describe('users', () => {
          it('POSTs /api/users', () => {});
        });
      `,
    );

    const result = await routeCoverageRule.check({ projectRoot: tmp });
    expect(result.status).toBe('pass');
  });

  it('passes vacuously when the manifest contains no routes', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        const app = new Hono();
        export default app;
      `,
    );

    const result = await routeCoverageRule.check({ projectRoot: tmp });
    expect(result.status).toBe('pass');
  });

  it('recursively finds integration tests in nested directories', async () => {
    writeApiEntry(
      tmp,
      `
        import { Hono } from 'hono';
        const app = new Hono();
        app.get('/api/widgets/:id', (c) => c.json({ id: c.req.param('id') }));
        export default app;
      `,
    );
    const nested = join(tmp, 'tests', 'integration', 'widgets');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'detail.test.ts'),
      `
        import { describe, it } from 'vitest';
        describe('widgets', () => {
          it('GETs /api/widgets/:id', () => {});
        });
      `,
    );

    const result = await routeCoverageRule.check({ projectRoot: tmp });
    expect(result.status).toBe('pass');
  });
});
