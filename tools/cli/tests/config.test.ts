import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-cfg-')));
});

describe('loadConfig', () => {
  it('loads an empty config', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default {};');
    const cfg = await loadConfig(path);
    expect(cfg).toEqual({});
  });

  it('loads a config with a name field', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default { name: "myapp" };');
    const cfg = await loadConfig(path);
    expect(cfg.name).toBe('myapp');
  });

  it('throws a useful error when config has no default export', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export const foo = 1;');
    await expect(loadConfig(path)).rejects.toThrow(/default export/i);
  });

  // ----- adapters block (LEV-103) -----------------------------------------

  it('loads a config with an adapters block', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: {
          orm: 'prisma',
          auth: 'better-auth',
        },
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.adapters).toEqual({ orm: 'prisma', auth: 'better-auth' });
  });

  it('loads a config with adapters.custom plugin paths', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: {
          orm: 'prisma',
          custom: {
            redis: './local-plugins/redis-adapter.ts',
            mailer: './local-plugins/mailer-adapter.ts',
          },
        },
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.adapters?.orm).toBe('prisma');
    expect(cfg.adapters?.custom).toEqual({
      redis: './local-plugins/redis-adapter.ts',
      mailer: './local-plugins/mailer-adapter.ts',
    });
  });

  it('accepts every valid adapter slot', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: {
          orm: 'prisma',
          auth: 'better-auth',
          ui: 'shadcn',
          browser: 'playwright',
          backend: 'hono',
          frontend: 'vite-react',
          'test-runner': 'vitest',
          portless: 'cloudflared',
        },
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.adapters).toEqual({
      orm: 'prisma',
      auth: 'better-auth',
      ui: 'shadcn',
      browser: 'playwright',
      backend: 'hono',
      frontend: 'vite-react',
      'test-runner': 'vitest',
      portless: 'cloudflared',
    });
  });

  it('throws a clear error for an unknown adapter slot', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: {
          nonsense: 'whatever',
        },
      };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/unknown adapter slot.*nonsense/i);
  });

  it('throws a clear error when adapters is not an object', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, `export default { adapters: 'prisma' };`);
    await expect(loadConfig(path)).rejects.toThrow(/adapters.*object/i);
  });

  it('throws when an adapter slot value is not a string', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: { orm: 123 },
      };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/adapters\.orm.*string/i);
  });

  it('throws when adapters.custom is not an object of strings', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        adapters: { custom: { redis: 42 } },
      };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/adapters\.custom\.redis.*string/i);
  });

  it('remains backward compatible when no adapters block is present', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default { name: "legacy" };');
    const cfg = await loadConfig(path);
    expect(cfg.name).toBe('legacy');
    expect(cfg.adapters).toBeUndefined();
  });

  // ----- plugins block (LEV-129) ------------------------------------------

  it('loads a config with a plugins array of string specifiers', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        plugins: [
          '@levelzero/plugin-postgres',
          './local-plugins/redis',
        ],
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.plugins).toEqual([
      '@levelzero/plugin-postgres',
      './local-plugins/redis',
    ]);
  });

  it('loads a config with a plugins array of Plugin objects', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `const postgres = {
        name: 'postgres',
        version: '1.0.0',
        register() {},
      };
      const redis = {
        name: 'redis',
        version: '2.0.0',
        register() {},
      };
      export default { plugins: [postgres, redis] };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.plugins).toHaveLength(2);
    const first = cfg.plugins![0] as { name: string; version: string };
    const second = cfg.plugins![1] as { name: string; version: string };
    expect(first.name).toBe('postgres');
    expect(first.version).toBe('1.0.0');
    expect(second.name).toBe('redis');
    expect(second.version).toBe('2.0.0');
  });

  it('loads a config with a plugins array of dynamic-import Promises', async () => {
    const pluginPath = join(tmp, 'my-plugin.ts');
    writeFileSync(
      pluginPath,
      `const plugin = {
        name: 'my-plugin',
        version: '0.1.0',
        register() {},
      };
      export default plugin;`,
    );
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default {
        plugins: [
          import('${pluginPath}'),
        ],
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.plugins).toHaveLength(1);
    const entry = cfg.plugins![0];
    expect(typeof (entry as Promise<unknown>).then).toBe('function');
    const resolved = (await entry) as { default: { name: string } };
    expect(resolved.default.name).toBe('my-plugin');
  });

  it('loads a config mixing all three plugin entry shapes', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `const inline = { name: 'inline', version: '1.0.0', register() {} };
      export default {
        plugins: [
          inline,
          './local-plugins/foo',
          Promise.resolve({ name: 'async', version: '0.0.1', register() {} }),
        ],
      };`,
    );
    const cfg = await loadConfig(path);
    expect(cfg.plugins).toHaveLength(3);
  });

  it('throws a clear error when plugins is not an array', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, `export default { plugins: 'not-an-array' };`);
    await expect(loadConfig(path)).rejects.toThrow(/plugins.*array/i);
  });

  it('throws a clear error when a plugin entry is a number, including the index', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default { plugins: ['ok', 42] };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/plugins\[1\]/);
  });

  it('throws a clear error when a plugin entry is null, including the index', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default { plugins: [null] };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/plugins\[0\]/);
  });

  it('throws a clear error when a plugin object is missing required fields', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(
      path,
      `export default { plugins: [{ name: 'incomplete' }] };`,
    );
    await expect(loadConfig(path)).rejects.toThrow(/plugins\[0\]/);
  });

  it('remains backward compatible when no plugins block is present', async () => {
    const path = join(tmp, 'levelzero.config.ts');
    writeFileSync(path, 'export default { name: "legacy" };');
    const cfg = await loadConfig(path);
    expect(cfg.name).toBe('legacy');
    expect(cfg.plugins).toBeUndefined();
  });
});
