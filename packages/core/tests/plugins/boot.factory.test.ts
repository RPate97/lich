import { describe, it, expect } from 'vitest';
import { bootPlugins } from '../../src/plugins/boot';
import type { LevelzeroConfig } from '../../src/config';
import type { Plugin, PluginFactory } from '../../src/plugins/types';

const PROJECT_ROOT = '/tmp/lz-boot-factory-test';

/**
 * LEV-179 — boot exercises plugins authored as factories (`() => Plugin`).
 * Covers the three new paths:
 *  - sync factory returning a Plugin
 *  - async factory returning a Promise<Plugin>
 *  - factory whose plugin omits `namespace` → loader auto-derives from `name`
 *
 * The fixtures here intentionally mirror the shape Plan 16 standardizes on
 * (`export default function postgres(opts?) { return { ... } }`) so adding a
 * regression test for a real plugin in LEV-186 stays mechanical.
 */
describe('bootPlugins — factory entries (LEV-179)', () => {
  it('invokes a sync factory and registers its plugin', async () => {
    const factory: PluginFactory<'postgres'> = () => ({
      name: '@levelzero/plugin-postgres',
      namespace: 'postgres',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', {
          host: () => 'pg-host',
          container: () => 'pg-container',
          protocol: 'postgres',
        });
      },
    });

    const result = await bootPlugins({ plugins: [factory] }, PROJECT_ROOT);

    expect(result.loadedPlugins).toEqual([
      { name: '@levelzero/plugin-postgres', version: '0.1.0' },
    ]);
    expect(result.envSources.getNamed('postgres.url')?.fullKey).toBe('postgres.url');
    expect(result.envSources.getNamed('postgres.url')?.source.protocol).toBe('postgres');
  });

  it('awaits an async factory and registers its plugin', async () => {
    const factory: PluginFactory<'redis'> = async () => ({
      name: '@levelzero/plugin-redis',
      namespace: 'redis',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', {
          host: () => 'redis://localhost:6379',
          container: () => 'redis://redis:6379',
          protocol: 'redis',
        });
      },
    });

    const result = await bootPlugins({ plugins: [factory] }, PROJECT_ROOT);
    expect(result.envSources.getNamed('redis.url')?.namespace).toBe('redis');
  });

  it('auto-derives the namespace when a factory plugin omits it', async () => {
    // Factory's plugin has no `namespace` field — loader should derive
    // `postgres` from `@levelzero/plugin-postgres`.
    const factory = (): Plugin => ({
      name: '@levelzero/plugin-postgres',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', { host: () => 'h', container: () => 'c' });
      },
    });

    const result = await bootPlugins({ plugins: [factory] }, PROJECT_ROOT);

    // Env source is namespaced under the derived `postgres`, not the full
    // package name. This is the consumer-facing payoff of LEV-179's loader
    // tweak: `defineConfig()` (LEV-180) can rely on the short namespace.
    expect(result.envSources.getNamed('postgres.url')).toBeDefined();
    expect(result.envSources.getNamed('@levelzero/plugin-postgres.url')).toBeUndefined();
  });

  it('passes factory options through to the resulting plugin', async () => {
    // Verifies the factory pattern's payoff: per-instance configuration. The
    // factory closes over `opts` and bakes them into the EnvSource resolvers.
    type Opts = { port: number };
    const postgres = (opts: Opts): Plugin<'postgres'> => ({
      name: '@levelzero/plugin-postgres',
      namespace: 'postgres',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', {
          host: () => `postgres://u:p@localhost:${opts.port}/db`,
          container: () => `postgres://u:p@postgres:${opts.port}/db`,
          protocol: 'postgres',
        });
      },
    });

    const config: LevelzeroConfig = { plugins: [postgres({ port: 5433 })] };
    const result = await bootPlugins(config, PROJECT_ROOT);
    const entry = result.envSources.getNamed('postgres.url');
    expect(entry).toBeDefined();
    const url = await entry!.source.host({
      ports: {},
      projectRoot: PROJECT_ROOT,
      worktreeKey: 'test',
      consumerContext: 'host',
    });
    expect(url).toBe('postgres://u:p@localhost:5433/db');
  });

  it('lets a config mix factory and Plugin-object entries side by side', async () => {
    const factoryPlugin: PluginFactory<'postgres'> = () => ({
      name: '@levelzero/plugin-postgres',
      namespace: 'postgres',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', { host: () => 'pg', container: () => 'pg' });
      },
    });
    const objectPlugin: Plugin<'mysql'> = {
      name: '@levelzero/plugin-mysql',
      namespace: 'mysql',
      version: '0.1.0',
      register(api) {
        api.addEnvSource('url', { host: () => 'my', container: () => 'my' });
      },
    };

    const result = await bootPlugins(
      { plugins: [factoryPlugin, objectPlugin] },
      PROJECT_ROOT,
    );
    expect(result.envSources.getNamed('postgres.url')).toBeDefined();
    expect(result.envSources.getNamed('mysql.url')).toBeDefined();
    expect(result.loadedPlugins).toHaveLength(2);
  });

  it('surfaces a register() error from a factory-created plugin with the plugin name', async () => {
    const exploding = (): Plugin => ({
      name: '@levelzero/plugin-explode',
      version: '0.0.1',
      register() {
        throw new Error('boom inside register');
      },
    });
    await expect(
      bootPlugins({ plugins: [exploding] }, PROJECT_ROOT),
    ).rejects.toThrow(/@levelzero\/plugin-explode.*boom inside register/);
  });
});
