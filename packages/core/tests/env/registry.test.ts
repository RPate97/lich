import { describe, expect, it } from 'vitest';
import { EnvSourceRegistry } from '../../src/env/registry';
import type { BulkEnvSource, EnvSource } from '../../src/env/types';

const stubSource = (): EnvSource => ({
  host: () => 'host-value',
  container: () => 'container-value',
});

const stubBulk = (): BulkEnvSource => ({
  resolve: () => ({ KEY: 'value' }),
});

describe('EnvSourceRegistry — named sources', () => {
  it('registers + retrieves a named source by full key', () => {
    const r = new EnvSourceRegistry();
    const source = stubSource();
    r.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source,
      pluginName: '@levelzero/plugin-postgres',
    });

    const entry = r.getNamed('postgres.url');
    expect(entry).toBeDefined();
    expect(entry?.namespace).toBe('postgres');
    expect(entry?.name).toBe('url');
    expect(entry?.fullKey).toBe('postgres.url');
    expect(entry?.source).toBe(source);
    expect(entry?.pluginName).toBe('@levelzero/plugin-postgres');
  });

  it('isolates same-name sources under different namespaces', () => {
    const r = new EnvSourceRegistry();
    const pgUrl = stubSource();
    const mysqlUrl = stubSource();
    r.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: pgUrl,
      pluginName: 'plugin-postgres',
    });
    r.registerNamed({
      namespace: 'mysql',
      name: 'url',
      fullKey: 'mysql.url',
      source: mysqlUrl,
      pluginName: 'plugin-mysql',
    });

    expect(r.getNamed('postgres.url')?.source).toBe(pgUrl);
    expect(r.getNamed('mysql.url')?.source).toBe(mysqlUrl);
    expect(r.listNamed()).toHaveLength(2);
  });

  it('throws on (namespace, name) collision with both plugin names in the message', () => {
    const r = new EnvSourceRegistry();
    r.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: stubSource(),
      pluginName: '@org/plugin-a',
    });

    expect(() =>
      r.registerNamed({
        namespace: 'postgres',
        name: 'url',
        fullKey: 'postgres.url',
        source: stubSource(),
        pluginName: '@org/plugin-b',
      }),
    ).toThrowError(/postgres\.url.*@org\/plugin-b.*@org\/plugin-a/);
  });

  it('returns undefined for unknown keys', () => {
    const r = new EnvSourceRegistry();
    expect(r.getNamed('nope.nada')).toBeUndefined();
  });

  it('listNamed returns a snapshot of every registration', () => {
    const r = new EnvSourceRegistry();
    r.registerNamed({
      namespace: 'a',
      name: 'x',
      fullKey: 'a.x',
      source: stubSource(),
      pluginName: 'p1',
    });
    r.registerNamed({
      namespace: 'b',
      name: 'y',
      fullKey: 'b.y',
      source: stubSource(),
      pluginName: 'p2',
    });
    expect(r.listNamed().map((e) => e.fullKey).sort()).toEqual(['a.x', 'b.y']);
  });

  it('findFirstNamed returns the first entry matching predicate (LEV-171)', () => {
    // The predicate path lets slot consumers locate "whichever plugin
    // provides protocol X" without coupling to a specific namespace —
    // see plugin-prisma's `db.*` commands.
    const r = new EnvSourceRegistry();
    r.registerNamed({
      namespace: 'postgres',
      name: 'host',
      fullKey: 'postgres.host',
      source: { host: () => 'localhost', container: () => 'postgres' },
      pluginName: 'plugin-postgres',
    });
    r.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: {
        protocol: 'postgres',
        host: () => 'postgres://h',
        container: () => 'postgres://c',
      },
      pluginName: 'plugin-postgres',
    });

    const urlEntry = r.findFirstNamed(
      (e) => e.source.protocol === 'postgres' && e.name === 'url',
    );
    expect(urlEntry?.fullKey).toBe('postgres.url');
  });

  it('findFirstNamed returns undefined when nothing matches', () => {
    const r = new EnvSourceRegistry();
    r.registerNamed({
      namespace: 'redis',
      name: 'url',
      fullKey: 'redis.url',
      source: { protocol: 'redis', host: () => '', container: () => '' },
      pluginName: 'plugin-redis',
    });
    const noMatch = r.findFirstNamed((e) => e.source.protocol === 'postgres');
    expect(noMatch).toBeUndefined();
  });
});

describe('EnvSourceRegistry — bulk sources', () => {
  it('registers + retrieves a bulk source by namespace', () => {
    const r = new EnvSourceRegistry();
    const source = stubBulk();
    r.registerBulk({ namespace: 'infisical', source, pluginName: 'plugin-infisical' });

    const entry = r.getBulk('infisical');
    expect(entry).toBeDefined();
    expect(entry?.namespace).toBe('infisical');
    expect(entry?.source).toBe(source);
    expect(entry?.pluginName).toBe('plugin-infisical');
  });

  it('throws on namespace collision with both plugin names in the message', () => {
    const r = new EnvSourceRegistry();
    r.registerBulk({ namespace: 'dotenv', source: stubBulk(), pluginName: 'plugin-dotenv-a' });

    expect(() =>
      r.registerBulk({
        namespace: 'dotenv',
        source: stubBulk(),
        pluginName: 'plugin-dotenv-b',
      }),
    ).toThrowError(/dotenv.*plugin-dotenv-b.*plugin-dotenv-a/);
  });

  it('returns undefined for unknown bulk namespaces', () => {
    const r = new EnvSourceRegistry();
    expect(r.getBulk('nope')).toBeUndefined();
  });

  it('listBulk returns a snapshot of every registration', () => {
    const r = new EnvSourceRegistry();
    r.registerBulk({ namespace: 'a', source: stubBulk(), pluginName: 'p1' });
    r.registerBulk({ namespace: 'b', source: stubBulk(), pluginName: 'p2' });
    expect(r.listBulk().map((e) => e.namespace).sort()).toEqual(['a', 'b']);
  });
});

describe('EnvSourceRegistry — cross-shape isolation', () => {
  it('named + bulk in the same namespace do not collide with each other', () => {
    const r = new EnvSourceRegistry();
    r.registerNamed({
      namespace: 'dotenv',
      name: 'foo',
      fullKey: 'dotenv.foo',
      source: stubSource(),
      pluginName: 'plugin-dotenv',
    });
    r.registerBulk({
      namespace: 'dotenv',
      source: stubBulk(),
      pluginName: 'plugin-dotenv',
    });

    expect(r.getNamed('dotenv.foo')).toBeDefined();
    expect(r.getBulk('dotenv')).toBeDefined();
    expect(r.listNamed()).toHaveLength(1);
    expect(r.listBulk()).toHaveLength(1);
  });
});
