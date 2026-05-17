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
});
