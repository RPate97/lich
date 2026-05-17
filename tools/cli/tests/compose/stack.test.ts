import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildComposeBundle, writeComposeFile } from '../../src/compose/stack';
import { pgService } from '../../src/services/postgres';
import type { StackContext } from '../../src/services/types';

describe('buildComposeBundle', () => {
  const ctx: StackContext = {
    worktreeKey: 'abcdef012345',
    worktreePath: '/tmp/lz-fake-worktree',
    branch: 'main',
  };

  it('produces project name, compose file path, containers, and substituted yaml', () => {
    const b = buildComposeBundle(ctx, [pgService], { postgres: 54123 });

    expect(b.projectName).toBe('levelzero-abcdef012345');
    expect(b.composeFilePath).toBe(
      '/tmp/lz-fake-worktree/.levelzero/abcdef012345/docker-compose.yml',
    );
    expect(b.containerNames).toEqual(['levelzero-abcdef012345-postgres']);

    const parsed = parseYaml(b.yaml) as {
      name: string;
      services: Record<string, { ports?: string[]; container_name?: string }>;
      volumes: Record<string, unknown>;
    };
    expect(parsed.name).toBe('levelzero-abcdef012345');
    expect(parsed.services.postgres!.container_name).toBe(
      'levelzero-abcdef012345-postgres',
    );
    expect(parsed.services.postgres!.ports).toEqual([
      '127.0.0.1:54123:5432',
    ]);
    expect(parsed.volumes['levelzero-abcdef012345-postgres-data']).toBeDefined();
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
    expect(parsed.name).toBe('levelzero-abcdef012345');
    expect(parsed.services).toEqual({});
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
    expect(onDisk).toContain('container_name: levelzero-0123456789ab-postgres');
    expect(onDisk).toContain('127.0.0.1:55001:5432');
  });
});
