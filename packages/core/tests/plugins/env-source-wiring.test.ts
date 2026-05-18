import { describe, expect, it } from 'vitest';
import { bootPlugins } from '../../src/plugins/boot';
import type { LevelzeroConfig } from '../../src/config';
import type { Plugin } from '../../src/plugins/types';

const PROJECT_ROOT = '/tmp/lz-envsource-wiring-test';

describe('bootPlugins — EnvSource wiring', () => {
  it('exposes an EnvSourceRegistry on BootResult', async () => {
    const result = await bootPlugins({} as LevelzeroConfig, PROJECT_ROOT);
    expect(result.envSources).toBeDefined();
    expect(result.envSources.listNamed()).toEqual([]);
    expect(result.envSources.listBulk()).toEqual([]);
  });

  it('composes the fully-qualified key from the plugin namespace when present', async () => {
    const postgres: Plugin<'postgres'> = {
      name: '@levelzero/plugin-postgres',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', {
          host: ({ ports }) => `postgres://u:p@localhost:${ports.postgres}/db`,
          container: () => 'postgres://u:p@postgres:5432/db',
          protocol: 'postgres',
        });
      },
    };

    const result = await bootPlugins({ plugins: [postgres] }, PROJECT_ROOT);
    const entry = result.envSources.getNamed('postgres.url');
    expect(entry).toBeDefined();
    expect(entry?.namespace).toBe('postgres');
    expect(entry?.name).toBe('url');
    expect(entry?.fullKey).toBe('postgres.url');
    expect(entry?.pluginName).toBe('@levelzero/plugin-postgres');
    expect(entry?.source.protocol).toBe('postgres');
  });

  it('falls back to plugin.name as the namespace when no `namespace` is set', async () => {
    const legacy: Plugin = {
      // No `namespace` field — the LEV-178 fallback is `plugin.name`.
      name: 'legacy-plugin',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('thing', {
          host: () => 'h',
          container: () => 'c',
        });
      },
    };
    const result = await bootPlugins({ plugins: [legacy] }, PROJECT_ROOT);
    expect(result.envSources.getNamed('legacy-plugin.thing')).toBeDefined();
  });

  it('wires bulk sources under the plugin namespace', async () => {
    const dotenv: Plugin<'dotenv'> = {
      name: '@levelzero/plugin-dotenv',
      namespace: 'dotenv',
      version: '0.0.1',
      register(api) {
        api.addBulkEnvSource({
          resolve: () => ({ FOO: 'bar', BAZ: 'qux' }),
        });
      },
    };
    const result = await bootPlugins({ plugins: [dotenv] }, PROJECT_ROOT);
    const entry = result.envSources.getBulk('dotenv');
    expect(entry).toBeDefined();
    expect(entry?.namespace).toBe('dotenv');
    expect(entry?.pluginName).toBe('@levelzero/plugin-dotenv');
  });

  it('lets two plugins with different namespaces register the same short name', async () => {
    const postgres: Plugin<'postgres'> = {
      name: '@levelzero/plugin-postgres',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'pg', container: () => 'pg-c' });
      },
    };
    const mysql: Plugin<'mysql'> = {
      name: '@levelzero/plugin-mysql',
      namespace: 'mysql',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'my', container: () => 'my-c' });
      },
    };
    const result = await bootPlugins({ plugins: [postgres, mysql] }, PROJECT_ROOT);
    expect(result.envSources.getNamed('postgres.url')).toBeDefined();
    expect(result.envSources.getNamed('mysql.url')).toBeDefined();
    expect(result.envSources.listNamed()).toHaveLength(2);
  });

  it('surfaces a collision when two plugins claim the same (namespace, name)', async () => {
    const a: Plugin<'postgres'> = {
      name: 'plugin-a',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'a', container: () => 'a' });
      },
    };
    const b: Plugin<'postgres'> = {
      name: 'plugin-b',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'b', container: () => 'b' });
      },
    };
    // The collision throws inside register(), and bootPlugins re-wraps with
    // the offending plugin's name as the outer message.
    await expect(bootPlugins({ plugins: [a, b] }, PROJECT_ROOT)).rejects.toThrow(
      /plugin-b.*postgres\.url.*plugin-a/,
    );
  });

  it('surfaces a collision when two plugins claim the same bulk namespace', async () => {
    const a: Plugin<'dotenv'> = {
      name: 'plugin-dotenv-a',
      namespace: 'dotenv',
      version: '0.0.1',
      register(api) {
        api.addBulkEnvSource({ resolve: () => ({ A: '1' }) });
      },
    };
    const b: Plugin<'dotenv'> = {
      name: 'plugin-dotenv-b',
      namespace: 'dotenv',
      version: '0.0.1',
      register(api) {
        api.addBulkEnvSource({ resolve: () => ({ B: '2' }) });
      },
    };
    await expect(bootPlugins({ plugins: [a, b] }, PROJECT_ROOT)).rejects.toThrow(
      /plugin-dotenv-b.*dotenv.*plugin-dotenv-a/,
    );
  });
});
