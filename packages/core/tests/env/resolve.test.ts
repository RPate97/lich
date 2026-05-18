import { describe, expect, it } from 'vitest';
import { EnvSourceRegistry } from '../../src/env/registry';
import {
  prepareBulkResolutions,
  resolveEnvForService,
  validateEnvInjection,
  type BulkResolutionCache,
  type EnvInjectionMap,
} from '../../src/env/resolve';
import {
  BulkResolveError,
  EnvSourceMissingError,
} from '../../src/env/errors';
import type { BulkEnvSource, EnvSource, EnvSourceContext } from '../../src/env/types';

const PROJECT_ROOT = '/tmp/lz-resolve-test';
const WORKTREE_KEY = 'wt-abcd1234';
const PORTS = { postgres: 5433, api: 3001 };

/** Fixture: a `postgres.url` named source with distinct host vs container values. */
function postgresUrlSource(): EnvSource {
  return {
    host: ({ ports }) => `postgres://u:p@localhost:${ports.postgres}/db`,
    container: () => 'postgres://u:p@postgres:5432/db',
    protocol: 'postgres',
  };
}

/** Fixture: a bulk source returning fixed keys. */
function infisicalSource(values: Record<string, string>): BulkEnvSource {
  return { resolve: () => values };
}

/** Register the standard postgres + infisical fixtures into a fresh registry. */
function fixtureRegistry(opts: {
  withPostgres?: boolean;
  withInfisical?: Record<string, string> | false;
} = {}): EnvSourceRegistry {
  const r = new EnvSourceRegistry();
  if (opts.withPostgres ?? true) {
    r.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: postgresUrlSource(),
      pluginName: '@levelzero/plugin-postgres',
    });
  }
  if (opts.withInfisical !== false) {
    r.registerBulk({
      namespace: 'infisical',
      source: infisicalSource(opts.withInfisical ?? {
        STRIPE_KEY: 'sk_test_infisical',
        SENTRY_DSN: 'https://sentry.io/infisical',
      }),
      pluginName: '@levelzero/plugin-infisical',
    });
  }
  return r;
}

describe('resolveEnvForService — happy paths', () => {
  it('resolves a single named source using the host resolver in host context', async () => {
    const registry = fixtureRegistry({ withInfisical: false });
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: { DATABASE_URL: 'postgres.url' },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({ DATABASE_URL: 'postgres://u:p@localhost:5433/db' });
  });

  it('resolves a single named source using the container resolver in container context', async () => {
    const registry = fixtureRegistry({ withInfisical: false });
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'container',
      registry,
      injection: { DATABASE_URL: 'postgres.url' },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({ DATABASE_URL: 'postgres://u:p@postgres:5432/db' });
  });

  it('imports every key from a bulk source via importAll', async () => {
    const registry = fixtureRegistry();
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: { importAll: ['infisical'] },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({
      STRIPE_KEY: 'sk_test_infisical',
      SENTRY_DSN: 'https://sentry.io/infisical',
    });
  });

  it('mixes a named source and importAll in one resolution', async () => {
    const registry = fixtureRegistry();
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: {
        DATABASE_URL: 'postgres.url',
        importAll: ['infisical'],
      },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({
      DATABASE_URL: 'postgres://u:p@localhost:5433/db',
      STRIPE_KEY: 'sk_test_infisical',
      SENTRY_DSN: 'https://sentry.io/infisical',
    });
  });

  it('resolves an explicit `${ns}.${runtimeKey}` reference against a bulk source', async () => {
    const registry = fixtureRegistry();
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: { MY_STRIPE: 'infisical.STRIPE_KEY' },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({ MY_STRIPE: 'sk_test_infisical' });
  });

  it('returns an empty map when envInjection is undefined', async () => {
    const registry = fixtureRegistry();
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: undefined,
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({});
  });

  it('returns an empty map when envInjection is empty', async () => {
    const registry = fixtureRegistry();
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: {},
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env).toEqual({});
  });
});

describe('resolveEnvForService — explicit overrides importAll', () => {
  it('lets an explicit named source override a wholesale-imported bulk key', async () => {
    const registry = fixtureRegistry({
      withInfisical: { DATABASE_URL: 'sk_bulk_database_url' },
    });
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: {
        importAll: ['infisical'],
        DATABASE_URL: 'postgres.url', // explicit beats importAll
      },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env.DATABASE_URL).toBe('postgres://u:p@localhost:5433/db');
  });

  it('lets an explicit ns.key override a wholesale-imported bulk key under a different env name', async () => {
    const registry = fixtureRegistry({
      withInfisical: { STRIPE_KEY: 'sk_infisical_default' },
    });
    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'host',
      registry,
      injection: {
        importAll: ['infisical'],
        // Same source name, but renamed via explicit injection — explicit
        // takes precedence and renames the key.
        STRIPE_API_KEY: 'infisical.STRIPE_KEY',
      },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(env.STRIPE_KEY).toBe('sk_infisical_default'); // wholesale
    expect(env.STRIPE_API_KEY).toBe('sk_infisical_default'); // renamed
  });
});

describe('resolveEnvForService — missing references', () => {
  it('throws ENV_SOURCE_MISSING when a named source key is not registered', async () => {
    const registry = fixtureRegistry();
    await expect(
      resolveEnvForService({
        serviceName: 'api',
        context: 'host',
        registry,
        injection: { DB_URL: 'nope.url' },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      }),
    ).rejects.toBeInstanceOf(EnvSourceMissingError);
  });

  it('throws ENV_SOURCE_MISSING when importAll references a missing bulk namespace', async () => {
    const registry = fixtureRegistry({ withInfisical: false });
    try {
      await resolveEnvForService({
        serviceName: 'api',
        context: 'host',
        registry,
        injection: { importAll: ['infisical'] },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvSourceMissingError);
      const e = err as EnvSourceMissingError;
      expect(e.code).toBe('ENV_SOURCE_MISSING');
      expect(e.sourceKey).toBe('infisical');
      expect(e.consumerService).toBe('api');
      expect(e.loadedNamespaces).toEqual(['postgres']);
      expect(e.message).toContain('api');
      expect(e.message).toContain('infisical');
    }
  });

  it('throws ENV_SOURCE_MISSING when ns.runtimeKey references an unknown bulk key', async () => {
    const registry = fixtureRegistry({
      withInfisical: { STRIPE_KEY: 'sk_x' },
    });
    await expect(
      resolveEnvForService({
        serviceName: 'api',
        context: 'host',
        registry,
        injection: { OPENAI_KEY: 'infisical.OPENAI_KEY' },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      }),
    ).rejects.toThrowError(/infisical\.OPENAI_KEY/);
  });

  it('includes loaded namespaces in the error message for typo discovery', async () => {
    const registry = fixtureRegistry();
    try {
      await resolveEnvForService({
        serviceName: 'web',
        context: 'host',
        registry,
        injection: { X: 'mysql.url' },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      });
      throw new Error('expected rejection');
    } catch (err) {
      const e = err as EnvSourceMissingError;
      expect(e.loadedNamespaces.sort()).toEqual(['infisical', 'postgres']);
      expect(e.message).toContain('postgres');
      expect(e.message).toContain('infisical');
    }
  });
});

describe('resolveEnvForService — bulk resolve failures', () => {
  it('wraps bulk resolver errors in BulkResolveError with the plugin name', async () => {
    const registry = new EnvSourceRegistry();
    registry.registerBulk({
      namespace: 'broken',
      source: {
        resolve: () => {
          throw new Error('network down');
        },
      },
      pluginName: '@org/plugin-broken',
    });
    try {
      await resolveEnvForService({
        serviceName: 'api',
        context: 'host',
        registry,
        injection: { importAll: ['broken'] },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BulkResolveError);
      const e = err as BulkResolveError;
      expect(e.code).toBe('BULK_RESOLVE_FAILED');
      expect(e.namespace).toBe('broken');
      expect(e.pluginName).toBe('@org/plugin-broken');
      expect(e.message).toContain('network down');
    }
  });

  it('wraps async-rejected bulk resolves too', async () => {
    const registry = new EnvSourceRegistry();
    registry.registerBulk({
      namespace: 'async-broken',
      source: { resolve: async () => Promise.reject(new Error('async fail')) },
      pluginName: '@org/plugin-async',
    });
    await expect(
      resolveEnvForService({
        serviceName: 'api',
        context: 'host',
        registry,
        injection: { importAll: ['async-broken'] },
        ports: PORTS,
        projectRoot: PROJECT_ROOT,
        worktreeKey: WORKTREE_KEY,
      }),
    ).rejects.toBeInstanceOf(BulkResolveError);
  });
});

describe('resolveEnvForService — shared bulk cache', () => {
  it('reuses a shared bulkCache across multiple resolve calls', async () => {
    let callCount = 0;
    const registry = new EnvSourceRegistry();
    registry.registerBulk({
      namespace: 'counted',
      source: {
        resolve: () => {
          callCount++;
          return { COUNTED_KEY: 'v' };
        },
      },
      pluginName: 'plugin-counted',
    });

    const bulkCache: BulkResolutionCache = new Map();
    const inj: EnvInjectionMap = { importAll: ['counted'] };

    await resolveEnvForService({
      serviceName: 'a',
      context: 'host',
      registry,
      injection: inj,
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
      bulkCache,
    });
    await resolveEnvForService({
      serviceName: 'b',
      context: 'host',
      registry,
      injection: inj,
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
      bulkCache,
    });

    expect(callCount).toBe(1);
  });

  it('passes consumerContext to bulk resolvers so they can branch on host vs container', async () => {
    const seen: EnvSourceContext[] = [];
    const registry = new EnvSourceRegistry();
    registry.registerBulk({
      namespace: 'ctx',
      source: {
        resolve: (ctx) => {
          seen.push(ctx);
          return { CTX: ctx.consumerContext };
        },
      },
      pluginName: 'plugin-ctx',
    });

    const env = await resolveEnvForService({
      serviceName: 'api',
      context: 'container',
      registry,
      injection: { importAll: ['ctx'] },
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.consumerContext).toBe('container');
    expect(env.CTX).toBe('container');
  });
});

describe('prepareBulkResolutions', () => {
  it('populates the cache for every registered bulk source', async () => {
    const registry = fixtureRegistry({
      withInfisical: { A: '1', B: '2' },
    });
    registry.registerBulk({
      namespace: 'dotenv',
      source: infisicalSource({ C: '3' }),
      pluginName: 'plugin-dotenv',
    });
    const cache = new Map<string, Record<string, string>>();
    await prepareBulkResolutions(registry, cache, {
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
      consumerContext: 'host',
    });
    expect(cache.get('infisical')).toEqual({ A: '1', B: '2' });
    expect(cache.get('dotenv')).toEqual({ C: '3' });
  });

  it('skips namespaces already present in the cache', async () => {
    let callCount = 0;
    const registry = new EnvSourceRegistry();
    registry.registerBulk({
      namespace: 'cached',
      source: {
        resolve: () => {
          callCount++;
          return { X: 'fresh' };
        },
      },
      pluginName: 'plugin-cached',
    });
    const cache = new Map<string, Record<string, string>>();
    cache.set('cached', { X: 'stale' });

    await prepareBulkResolutions(registry, cache, {
      ports: PORTS,
      projectRoot: PROJECT_ROOT,
      worktreeKey: WORKTREE_KEY,
      consumerContext: 'host',
    });
    expect(callCount).toBe(0);
    expect(cache.get('cached')).toEqual({ X: 'stale' });
  });
});

describe('validateEnvInjection', () => {
  it('passes when every reference resolves', () => {
    const registry = fixtureRegistry();
    expect(() =>
      validateEnvInjection(registry, {
        DATABASE_URL: 'postgres.url',
        MY_STRIPE: 'infisical.STRIPE_KEY', // runtime key — deferred
        importAll: ['infisical'],
      }),
    ).not.toThrow();
  });

  it('throws on unknown named source key', () => {
    const registry = fixtureRegistry();
    expect(() =>
      validateEnvInjection(registry, { X: 'nope.url' }),
    ).toThrowError(EnvSourceMissingError);
  });

  it('throws on importAll referencing unknown bulk namespace', () => {
    const registry = fixtureRegistry({ withInfisical: false });
    expect(() =>
      validateEnvInjection(registry, { importAll: ['infisical'] }),
    ).toThrowError(/infisical/);
  });

  it('accepts undefined injection silently', () => {
    const registry = fixtureRegistry();
    expect(() => validateEnvInjection(registry, undefined)).not.toThrow();
  });

  it('defers ns.runtimeKey validation when ns is a known bulk namespace', () => {
    const registry = fixtureRegistry();
    // `infisical.NOT_YET_KNOWN` is statically OK because `infisical` is a
    // known bulk namespace; the runtime key isn't checkable without
    // awaiting the resolver. {@link resolveEnvForService} does that check.
    expect(() =>
      validateEnvInjection(registry, { X: 'infisical.NOT_YET_KNOWN' }),
    ).not.toThrow();
  });
});
