import { describe, expect, it } from 'vitest';
import { bootPlugins } from '../../src/plugins/boot';
import { EnvSourceMissingError, NamespaceCollisionError } from '../../src/env/errors';
import type { LevelzeroConfig } from '../../src/config';
import type { Plugin } from '../../src/plugins/types';

const PROJECT_ROOT = '/tmp/lz-boot-validation-test';

describe('bootPlugins — namespace collision detection', () => {
  it('throws NamespaceCollisionError when two plugins claim the same namespace via disjoint names', async () => {
    // Each plugin individually succeeds at the registry level — they
    // contribute different named keys (`postgres.url` vs `postgres.host`),
    // so the per-(namespace, name) collision check inside the registry
    // doesn't fire. The cross-plugin namespace check in bootPlugins is
    // what catches this misconfiguration.
    const a: Plugin<'postgres'> = {
      name: '@org/plugin-a',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'a', container: () => 'a' });
      },
    };
    const b: Plugin<'postgres'> = {
      name: '@org/plugin-b',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('host', { host: () => 'b', container: () => 'b' });
      },
    };
    try {
      await bootPlugins({ plugins: [a, b] }, PROJECT_ROOT);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(NamespaceCollisionError);
      const e = err as NamespaceCollisionError;
      expect(e.namespace).toBe('postgres');
      expect(e.plugins).toEqual(['@org/plugin-a', '@org/plugin-b']);
      expect(e.code).toBe('NAMESPACE_COLLISION');
      expect(e.message).toContain('@org/plugin-a');
      expect(e.message).toContain('@org/plugin-b');
    }
  });

  it('throws NamespaceCollisionError when one plugin adds a named source and another adds a bulk source under the same namespace', async () => {
    const a: Plugin<'shared'> = {
      name: 'plugin-a',
      namespace: 'shared',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('thing', { host: () => 'x', container: () => 'x' });
      },
    };
    const b: Plugin<'shared'> = {
      name: 'plugin-b',
      namespace: 'shared',
      version: '0.0.1',
      register(api) {
        api.addBulkEnvSource({ resolve: () => ({ K: 'v' }) });
      },
    };
    await expect(bootPlugins({ plugins: [a, b] }, PROJECT_ROOT)).rejects.toBeInstanceOf(
      NamespaceCollisionError,
    );
  });

  it('does NOT throw when a single plugin registers multiple sources under its own namespace', async () => {
    const single: Plugin<'postgres'> = {
      name: 'plugin-postgres',
      namespace: 'postgres',
      version: '0.0.1',
      register(api) {
        api.addEnvSource('url', { host: () => 'u', container: () => 'u' });
        api.addEnvSource('host', { host: () => 'h', container: () => 'h' });
        api.addEnvSource('port', { host: () => 'p', container: () => 'p' });
      },
    };
    await expect(bootPlugins({ plugins: [single] }, PROJECT_ROOT)).resolves.toBeDefined();
  });
});

describe('bootPlugins — envInjection validation', () => {
  const postgres: Plugin<'postgres'> = {
    name: '@levelzero/plugin-postgres',
    namespace: 'postgres',
    version: '0.0.1',
    register(api) {
      api.addEnvSource('url', {
        host: ({ ports }) => `postgres://localhost:${ports.postgres ?? 5432}/db`,
        container: () => 'postgres://postgres:5432/db',
      });
    },
  };

  const infisical: Plugin<'infisical'> = {
    name: '@levelzero/plugin-infisical',
    namespace: 'infisical',
    version: '0.0.1',
    register(api) {
      api.addBulkEnvSource({ resolve: () => ({ STRIPE_KEY: 'sk_test' }) });
    },
  };

  it('passes when every envInjection reference resolves', async () => {
    const config: LevelzeroConfig = {
      plugins: [postgres, infisical],
      envInjection: {
        DATABASE_URL: 'postgres.url',
        MY_STRIPE: 'infisical.STRIPE_KEY',
        importAll: ['infisical'],
      },
    };
    await expect(bootPlugins(config, PROJECT_ROOT)).resolves.toBeDefined();
  });

  it('throws ENV_SOURCE_MISSING when envInjection references an unknown named source', async () => {
    const config: LevelzeroConfig = {
      plugins: [postgres],
      envInjection: { X: 'mysql.url' },
    };
    try {
      await bootPlugins(config, PROJECT_ROOT);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvSourceMissingError);
      const e = err as EnvSourceMissingError;
      expect(e.code).toBe('ENV_SOURCE_MISSING');
      expect(e.sourceKey).toBe('mysql.url');
      expect(e.loadedNamespaces).toEqual(['postgres']);
    }
  });

  it('throws ENV_SOURCE_MISSING when importAll references an unknown bulk namespace', async () => {
    const config: LevelzeroConfig = {
      plugins: [postgres], // no infisical
      envInjection: { importAll: ['infisical'] },
    };
    await expect(bootPlugins(config, PROJECT_ROOT)).rejects.toBeInstanceOf(
      EnvSourceMissingError,
    );
  });

  it('throws ENV_SOURCE_MISSING when explicit entry references a namespace with no source', async () => {
    const config: LevelzeroConfig = {
      plugins: [postgres],
      envInjection: { K: 'unloaded.something' },
    };
    await expect(bootPlugins(config, PROJECT_ROOT)).rejects.toThrowError(/unloaded\.something/);
  });

  it('defers runtime-key validation when the namespace is a known bulk source', async () => {
    // `infisical.WHATEVER` is statically allowed because `infisical` IS a
    // registered bulk namespace; the runtime key check happens later in
    // resolveEnvForService.
    const config: LevelzeroConfig = {
      plugins: [postgres, infisical],
      envInjection: { K: 'infisical.NOT_KNOWN_YET' },
    };
    await expect(bootPlugins(config, PROJECT_ROOT)).resolves.toBeDefined();
  });

  it('returns an empty bulk-source cache from boot (resolution is lazy)', async () => {
    const result = await bootPlugins(
      { plugins: [postgres, infisical] },
      PROJECT_ROOT,
    );
    expect(result.resolvedBulkSources).toBeInstanceOf(Map);
    expect(result.resolvedBulkSources.size).toBe(0);
  });
});
