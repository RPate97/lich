import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { dockerOrSkip } from '../_helpers/docker';
import { makePrismaFixture } from '../_helpers/prisma-fixture';
import { Registry } from '../../src/registry';
import { makeDevCommand } from '../../src/commands/dev';
import { computeWorktreeKey } from '../../src/worktree';
import { containerName, volumeName } from '../../src/compose/naming';
import { prismaAdapter } from '@levelzero/plugin-prisma';
import { pgService } from '@levelzero/plugin-postgres';
import type { Service } from '../../src/services/types';
import { withRollback, RollbackSignal } from '../../src/testing/rollback';

// Keep dev's surface narrow for this fixture — only postgres needs to come up.
const onlyPostgres = (): Service[] => [pgService];

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

// Force IPv4 host: Levelzero binds postgres on 127.0.0.1:<port>, but Node may
// prefer ::1 by default which yields ECONNREFUSED on dual-stack systems.
function ipv4(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString();
  } catch {
    return url;
  }
}

describe('RollbackSignal (unit)', () => {
  it('is an Error subclass that carries a typed value', () => {
    const sig = new RollbackSignal({ id: 'abc', count: 7 });
    expect(sig).toBeInstanceOf(Error);
    expect(sig.name).toBe('RollbackSignal');
    expect(sig.value).toEqual({ id: 'abc', count: 7 });
  });

  it('preserves the marker name so the instanceof check is robust across realms', () => {
    // We rely on `err instanceof RollbackSignal` to distinguish our rollback
    // throw from a user error. The `.name` field is a secondary identifier
    // useful for debugging stack traces.
    const sig = new RollbackSignal('hello');
    expect(sig.message).toBe('RollbackSignal');
  });
});

let projectDir: string;
let homeDir: string;
let registry: Registry;
let databaseUrl: string;
let fixtureRoot: string;
let prisma: PrismaClient;

describeIfDocker('withRollback (integration)', () => {
  beforeEach(async () => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-rb-proj-')));
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-rb-home-')));
    writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
    registry = new Registry(join(homeDir, 'registry.json'));
    // Disjoint port reservation from other suites so dev's allocator doesn't collide.
    await registry.upsert('rollback-reserved-base', {
      path: '/__rollback_reserved__',
      branch: '',
      ports: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, 54200 + i])),
      urls: {},
      containers: [],
      network: '',
      logDir: '',
      createdAt: new Date().toISOString(),
    });
    const dev = makeDevCommand(() => registry, { getServices: onlyPostgres });
    const result = (await dev.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { env: { DATABASE_URL: string } };
    databaseUrl = result.env.DATABASE_URL;
    fixtureRoot = makePrismaFixture();
    await prismaAdapter.applyMigrations({ databaseUrl, projectRoot: fixtureRoot });
    prisma = new PrismaClient({ datasources: { db: { url: ipv4(databaseUrl) } } });
  }, 180_000);

  afterEach(async () => {
    if (prisma) await prisma.$disconnect();
    if (projectDir) {
      const k = computeWorktreeKey(projectDir);
      spawnSync('docker', ['rm', '-f', containerName(k, 'postgres')], { stdio: 'ignore' });
      spawnSync('docker', ['volume', 'rm', '-f', volumeName(k, 'postgres')], { stdio: 'ignore' });
    }
  });


  it('inserts inside the callback are visible to the callback but invisible after return', async () => {
    const email = `inside-${Date.now()}@example.com`;
    const seenInside = await withRollback(prisma, async (tx) => {
      await tx.user.create({ data: { email } });
      const row = await tx.user.findUnique({ where: { email } });
      return row;
    });
    // The body could see the row it just wrote.
    expect(seenInside).not.toBeNull();
    expect((seenInside as { email: string }).email).toBe(email);

    // ...but after the transaction rolled back, the row is gone.
    const outside = await prisma.user.findUnique({ where: { email } });
    expect(outside).toBeNull();
  }, 120_000);

  it('returns the callback value to the caller', async () => {
    const value = await withRollback(prisma, async () => ({ answer: 42 }));
    expect(value).toEqual({ answer: 42 });
  }, 60_000);

  it('propagates unrelated exceptions thrown inside the body', async () => {
    const email = `error-${Date.now()}@example.com`;
    await expect(
      withRollback(prisma, async (tx) => {
        await tx.user.create({ data: { email } });
        throw new Error('boom from body');
      }),
    ).rejects.toThrow(/boom from body/);

    // And the failed body's writes still rolled back.
    const outside = await prisma.user.findUnique({ where: { email } });
    expect(outside).toBeNull();
  }, 120_000);

  it('isolates writes between successive withRollback calls (clean slate per call)', async () => {
    const email = `iso-${Date.now()}@example.com`;
    await withRollback(prisma, async (tx) => {
      await tx.user.create({ data: { email } });
    });
    // Second call should not see the first call's row at all.
    const seenInSecond = await withRollback(prisma, async (tx) => {
      return tx.user.findUnique({ where: { email } });
    });
    expect(seenInSecond).toBeNull();
  }, 120_000);
});
