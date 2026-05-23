import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterRegistry,
  EnvSourceRegistry,
  type GeneratorContext,
  type ORMAdapter,
  type ORMContext,
} from '@lich/core';
import { makePrismaGenerator } from '../src/generator';

function stubAdapter(impl: (ctx: ORMContext) => Promise<void>): ORMAdapter {
  // Minimal stub — the generator only ever calls `generateClient`. The
  // remaining methods are spies that throw if anything else reaches in,
  // which would indicate a regression we want to catch.
  const unused = (): never => {
    throw new Error('unexpected adapter call');
  };
  return {
    name: 'stub-prisma',
    generateClient: vi.fn(impl) as unknown as ORMAdapter['generateClient'],
    applyMigrations: unused as unknown as ORMAdapter['applyMigrations'],
    newMigration: unused as unknown as ORMAdapter['newMigration'],
    seed: unused as unknown as ORMAdapter['seed'],
    inspectSchema: unused as unknown as ORMAdapter['inspectSchema'],
    inspectTable: unused as unknown as ORMAdapter['inspectTable'],
    resetDatabase: unused as unknown as ORMAdapter['resetDatabase'],
  };
}

function makeCtx(opts: {
  projectRoot: string;
  envSources?: EnvSourceRegistry;
}): GeneratorContext {
  return {
    projectRoot: opts.projectRoot,
    envSources: opts.envSources ?? new EnvSourceRegistry(),
    adapters: new AdapterRegistry(),
    flags: {},
  };
}

let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-prisma-gen-')));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('prismaGenerator (LEV-124)', () => {
  it('has the right id + describe', () => {
    const gen = makePrismaGenerator();
    expect(gen.id).toBe('prisma');
    expect(typeof gen.describe).toBe('string');
  });

  it('skips when no prisma/schema.prisma exists', async () => {
    const gen = makePrismaGenerator({ adapter: stubAdapter(async () => {}) });
    const result = await gen.generate(makeCtx({ projectRoot: projectDir }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('schema');
  });

  it('invokes adapter.generateClient when prisma/schema.prisma exists', async () => {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true });
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), '// stub');

    const adapter = stubAdapter(async () => {});
    const gen = makePrismaGenerator({ adapter });
    const result = await gen.generate(makeCtx({ projectRoot: projectDir }));

    expect(result.status).toBe('ok');
    expect(adapter.generateClient).toHaveBeenCalledTimes(1);
    const callArgs = (adapter.generateClient as unknown as { mock: { calls: ORMContext[][] } })
      .mock.calls[0]![0]!;
    expect(callArgs.projectRoot).toBe(projectDir);
    // A placeholder URL is passed when no env source resolved one.
    expect(typeof callArgs.databaseUrl).toBe('string');
    expect(callArgs.databaseUrl.length).toBeGreaterThan(0);
  });

  it('threads a resolved DATABASE_URL from the env source registry', async () => {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true });
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), '// stub');

    const envSources = new EnvSourceRegistry();
    envSources.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: {
        host: async () => 'postgres://u:p@localhost:5433/db',
        container: async () => 'postgres://u:p@postgres:5432/db',
        protocol: 'postgres',
      },
      pluginName: '@lich/plugin-postgres',
    });

    const adapter = stubAdapter(async () => {});
    const gen = makePrismaGenerator({ adapter });
    await gen.generate(makeCtx({ projectRoot: projectDir, envSources }));

    const callArgs = (adapter.generateClient as unknown as { mock: { calls: ORMContext[][] } })
      .mock.calls[0]![0]!;
    expect(callArgs.databaseUrl).toBe('postgres://u:p@localhost:5433/db');
  });

  it('falls back to the placeholder URL when the env source throws', async () => {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true });
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), '// stub');

    const envSources = new EnvSourceRegistry();
    envSources.registerNamed({
      namespace: 'postgres',
      name: 'url',
      fullKey: 'postgres.url',
      source: {
        host: async () => {
          throw new Error('no port allocated');
        },
        container: async () => 'unused',
        protocol: 'postgres',
      },
      pluginName: '@lich/plugin-postgres',
    });

    const adapter = stubAdapter(async () => {});
    const gen = makePrismaGenerator({ adapter });
    const result = await gen.generate(makeCtx({ projectRoot: projectDir, envSources }));

    // The throw is swallowed — generator falls back to the placeholder URL
    // so `prisma generate` (which never opens a connection) still runs.
    expect(result.status).toBe('ok');
    const callArgs = (adapter.generateClient as unknown as { mock: { calls: ORMContext[][] } })
      .mock.calls[0]![0]!;
    expect(callArgs.databaseUrl).toContain('placeholder');
  });

  it('returns status: "fail" with the underlying message when adapter.generateClient throws', async () => {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true });
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), '// stub');

    const adapter = stubAdapter(async () => {
      throw new Error('prisma generate exit 1');
    });
    const gen = makePrismaGenerator({ adapter });
    const result = await gen.generate(makeCtx({ projectRoot: projectDir }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('prisma generate exit 1');
  });
});
