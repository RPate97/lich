import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerOrSkip } from '../../_helpers/docker';
import { Registry } from '../../../src/registry';
import { makeDevCommand } from '../../../src/commands/dev';
import { computeWorktreeKey } from '../../../src/worktree';
import { containerName, volumeName } from '../../../src/compose/naming';
import { makePrismaFixture } from '../../_helpers/prisma-fixture';
import { prismaAdapter } from '../../../src/adapters/orm/prisma';
import { pgService } from '@levelzero/plugin-postgres';
import type { Service } from '../../../src/services/types';

// Default builtins now include api+web OwnedServices (LEV-90). Inject
// `[pgService]` so dev only manages postgres in this tmpdir fixture (this
// test only needs DATABASE_URL).
const onlyPostgres = (): Service[] => [pgService];

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

let projectDir: string;
let homeDir: string;
let registry: Registry;
let databaseUrl: string;
let fixtureRoot: string;

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-pri-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-pri-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  // Reserve ports 54000-54079 so this file's dev lands at 54080+ (disjoint from prior files).
  await registry.upsert('prisma-reserved-base', {
    path: '/__prisma_reserved__',
    branch: '',
    ports: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, 54000 + i])),
    urls: {},
    containers: [],
    network: '',
    logDir: '',
    createdAt: new Date().toISOString(),
  });
  const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
  const result = (await dev.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
  databaseUrl = result.env.DATABASE_URL;
  fixtureRoot = makePrismaFixture();
}, 120_000);

afterEach(() => {
  if (projectDir) {
    const k = computeWorktreeKey(projectDir);
    spawnSync('docker', ['rm', '-f', containerName(k, 'postgres')], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', '-f', volumeName(k, 'postgres')], { stdio: 'ignore' });
  }
});

describeIfDocker('prismaAdapter (integration)', () => {
  it('applyMigrations runs the fixture migration and reports applied count', async () => {
    const result = await prismaAdapter.applyMigrations({ databaseUrl, projectRoot: fixtureRoot });
    expect(result.applied).toBeGreaterThanOrEqual(0); // First run may be 1 (init), reruns 0.
    expect(typeof result.output).toBe('string');
  }, 120_000);

  it('inspectSchema returns the User table after migrations', async () => {
    await prismaAdapter.applyMigrations({ databaseUrl, projectRoot: fixtureRoot });
    const schema = await prismaAdapter.inspectSchema({ databaseUrl, projectRoot: fixtureRoot });
    expect(schema.tables.User).toBeDefined();
    expect(schema.tables.User!.columns.map((c) => c.name).sort()).toEqual(['createdAt', 'email', 'id']);
  }, 120_000);

  it('inspectTable returns empty array for empty User table', async () => {
    await prismaAdapter.applyMigrations({ databaseUrl, projectRoot: fixtureRoot });
    const rows = await prismaAdapter.inspectTable({ databaseUrl, projectRoot: fixtureRoot }, 'User');
    expect(rows).toEqual([]);
  }, 120_000);

  it('resetDatabase drops + recreates tables', async () => {
    await prismaAdapter.applyMigrations({ databaseUrl, projectRoot: fixtureRoot });
    await prismaAdapter.resetDatabase({ databaseUrl, projectRoot: fixtureRoot });
    // After reset, no User table.
    const schema = await prismaAdapter.inspectSchema({ databaseUrl, projectRoot: fixtureRoot });
    expect(schema.tables.User).toBeUndefined();
  }, 180_000);
});
