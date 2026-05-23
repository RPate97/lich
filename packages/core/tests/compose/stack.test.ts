import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildComposeBundle, writeComposeFile } from '../../src/compose/stack';
import { pgService } from '@lich/plugin-postgres';
import type { StackContext } from '../../src/services/types';

// LEV-202 — vitest's globalSetup stamps TEST_RUN_ID for the whole
// process, which the naming helpers fold into every project/network/
// container/volume name. This file's assertions exercise the production
// naming path (no TEST_RUN_ID infix), so we strip the env var around
// each case and restore it on teardown. Sibling files that DO want the
// prefix flow (e.g. integration tests that need parallel-agent isolation)
// leave it set.
let PREV_TEST_RUN_ID: string | undefined;
beforeEach(() => {
  PREV_TEST_RUN_ID = process.env.TEST_RUN_ID;
  delete process.env.TEST_RUN_ID;
});
afterEach(() => {
  if (PREV_TEST_RUN_ID === undefined) delete process.env.TEST_RUN_ID;
  else process.env.TEST_RUN_ID = PREV_TEST_RUN_ID;
});

describe('buildComposeBundle', () => {
  const ctx: StackContext = {
    worktreeKey: 'abcdef012345',
    worktreePath: '/tmp/lz-fake-worktree',
    branch: 'main',
  };

  it('produces project name, compose file path, containers, and substituted yaml', () => {
    const b = buildComposeBundle(ctx, [pgService], { postgres: 54123 });

    expect(b.projectName).toBe('lich-abcdef012345');
    expect(b.composeFilePath).toBe(
      '/tmp/lz-fake-worktree/.lich/abcdef012345/docker-compose.yml',
    );
    expect(b.containerNames).toEqual(['lich-abcdef012345-postgres']);

    const parsed = parseYaml(b.yaml) as {
      name: string;
      services: Record<string, { ports?: string[]; container_name?: string }>;
      volumes: Record<string, unknown>;
    };
    expect(parsed.name).toBe('lich-abcdef012345');
    expect(parsed.services.postgres!.container_name).toBe(
      'lich-abcdef012345-postgres',
    );
    expect(parsed.services.postgres!.ports).toEqual([
      '127.0.0.1:54123:5432',
    ]);
    expect(parsed.volumes['lich-abcdef012345-postgres-data']).toBeDefined();
  });

  it('returns an empty bundle for zero docker services', () => {
    const b = buildComposeBundle(ctx, [], {});
    expect(b.containerNames).toEqual([]);
    expect(Object.keys(b.services)).toEqual([]);
    // YAML still has the `name:` and an empty `services:` map.
    const parsed = parseYaml(b.yaml) as {
      name: string;
      services: Record<string, unknown>;
    };
    expect(parsed.name).toBe('lich-abcdef012345');
    expect(parsed.services).toEqual({});
  });

  it('merges plugin compose contributions on top of legacy DockerService output', () => {
    const b = buildComposeBundle(
      ctx,
      [],
      { redis: 54200 },
      {
        services: {
          redis: {
            image: 'redis:7-alpine',
            ports: ['${PORT_redis}:6379'],
          },
        },
        volumes: { rediscache: {} },
        networks: {},
      },
    );

    expect(Object.keys(b.services)).toEqual(['redis']);
    expect(b.services.redis!.image).toBe('redis:7-alpine');
    const parsed = parseYaml(b.yaml) as {
      services: Record<string, { ports?: string[] }>;
      volumes: Record<string, unknown>;
    };
    expect(parsed.services.redis!.ports).toEqual(['54200:6379']);
    expect(parsed.volumes.rediscache).toEqual({});
  });

  it('plugin compose service overrides a same-named legacy DockerService entry', () => {
    const b = buildComposeBundle(
      ctx,
      [pgService],
      { postgres: 54123 },
      {
        services: {
          postgres: {
            image: 'postgres:16-alpine',
            ports: ['${PORT_postgres}:5432'],
            environment: { POSTGRES_USER: 'override' },
          },
        },
        volumes: {},
        networks: {},
      },
    );

    expect(b.services.postgres!.environment).toEqual({ POSTGRES_USER: 'override' });
    // The plugin entry has no `container_name`, so containerNames only carries
    // the legacy DockerService's pinned name from the first pass.
    expect(b.containerNames).toEqual(['lich-abcdef012345-postgres']);
  });

  // LEV-182 — `serviceEnv` parameter merges into each service's
  // `environment:` block. Validates the pre-existing-bug fix:
  // compose services receive their resolved env now, where before
  // `buildComposeBundle` had no env input at all.
  it('merges per-service env into the compose `environment:` block', () => {
    const b = buildComposeBundle(
      ctx,
      [],
      { postgres: 54200 },
      {
        services: {
          postgres: {
            image: 'postgres:16-alpine',
            ports: ['${PORT_postgres}:5432'],
          },
        },
        volumes: {},
        networks: {},
      },
      {
        postgres: {
          DATABASE_URL: 'postgres://u:p@postgres:5432/db',
          API_BASE: 'http://api:3000',
        },
      },
    );

    expect(b.services.postgres!.environment).toEqual({
      DATABASE_URL: 'postgres://u:p@postgres:5432/db',
      API_BASE: 'http://api:3000',
    });
  });

  it('resolved per-service env wins over the underlying definition env', () => {
    const b = buildComposeBundle(
      ctx,
      [],
      { postgres: 54200 },
      {
        services: {
          postgres: {
            image: 'postgres:16-alpine',
            environment: { DATABASE_URL: 'old', POSTGRES_USER: 'lich' },
          },
        },
        volumes: {},
        networks: {},
      },
      {
        postgres: { DATABASE_URL: 'new' },
      },
    );

    // Resolved entry wins; entries it doesn't touch pass through.
    expect(b.services.postgres!.environment).toEqual({
      DATABASE_URL: 'new',
      POSTGRES_USER: 'lich',
    });
  });

  it('an empty per-service env map does not add an `environment:` block', () => {
    const b = buildComposeBundle(
      ctx,
      [],
      { postgres: 54200 },
      {
        services: {
          postgres: { image: 'postgres:16-alpine' },
        },
        volumes: {},
        networks: {},
      },
      { postgres: {} },
    );
    expect(b.services.postgres!.environment).toBeUndefined();
  });

  it('skips per-service env for services not in the merged set', () => {
    // The dispatcher resolves env per name from the merged compose service
    // set; in the rare case a name shows up only on the env map (e.g. a
    // typo in a future migration), the bundle silently ignores it.
    const b = buildComposeBundle(
      ctx,
      [],
      { postgres: 54200 },
      {
        services: {
          postgres: { image: 'postgres:16-alpine' },
        },
        volumes: {},
        networks: {},
      },
      {
        postgres: { A: '1' },
        ghost: { B: '2' }, // not in compose set
      },
    );
    expect(b.services.postgres!.environment).toEqual({ A: '1' });
    expect(b.services.ghost).toBeUndefined();
  });
});

describe('writeComposeFile', () => {
  it('persists bundle.yaml at bundle.composeFilePath, creating parents', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lz-compose-stack-')));
    const ctx: StackContext = {
      worktreeKey: '0123456789ab',
      worktreePath: root,
      branch: 'main',
    };
    const b = buildComposeBundle(ctx, [pgService], { postgres: 55001 });
    await writeComposeFile(b);

    const onDisk = readFileSync(b.composeFilePath, 'utf8');
    expect(onDisk).toBe(b.yaml);
    expect(onDisk).toContain('container_name: lich-0123456789ab-postgres');
    expect(onDisk).toContain('127.0.0.1:55001:5432');
  });
});
