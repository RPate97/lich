import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterRegistry,
  EnvSourceRegistry,
  type BackendAdapter,
  type RouteManifest,
  type GeneratorContext,
} from '@levelzero/core';
import { makeApiClientGenerator } from '../src/generator';

function stubBackend(
  impl: (projectRoot: string, options?: { entry?: string }) => Promise<RouteManifest>,
): BackendAdapter {
  return {
    name: 'stub-backend',
    extractRoutes: impl as unknown as BackendAdapter['extractRoutes'],
  };
}

function registryWithBackend(backend?: BackendAdapter): AdapterRegistry {
  const r = new AdapterRegistry();
  if (backend) {
    r.register({ slot: 'backend', name: 'stub', impl: backend });
    r.setActive('backend', 'stub');
  }
  return r;
}

function makeCtx(opts: {
  projectRoot: string;
  adapters?: AdapterRegistry;
  flags?: Record<string, string | boolean>;
}): GeneratorContext {
  return {
    projectRoot: opts.projectRoot,
    envSources: new EnvSourceRegistry(),
    adapters: opts.adapters ?? new AdapterRegistry(),
    flags: opts.flags ?? {},
  };
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'lz-api-client-gen-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('apiClientGenerator (LEV-124)', () => {
  it('has the right id + describe', () => {
    const gen = makeApiClientGenerator();
    expect(gen.id).toBe('api-client');
    expect(typeof gen.describe).toBe('string');
  });

  it('skips when no active backend adapter is registered', async () => {
    const gen = makeApiClientGenerator();
    const result = await gen.generate(makeCtx({ projectRoot: projectDir }));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('backend');
  });

  it('uses the built-in typed-client frontend impl as a fallback when no frontend slot is active', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [{ method: 'GET', path: '/api/health' }],
    };
    const backend = stubBackend(async () => manifest);
    const gen = makeApiClientGenerator();
    const result = await gen.generate(
      makeCtx({ projectRoot: projectDir, adapters: registryWithBackend(backend) }),
    );

    expect(result.status).toBe('ok');
    expect(result.filesWritten).toBeDefined();
    expect(result.filesWritten!.length).toBeGreaterThan(0);

    const written = await readFile(result.filesWritten![0]!, 'utf8');
    expect(written).toContain('export interface ApiClient');
    expect(written).toContain('getApiHealth');
  });

  it('threads --api-dir through to the backend adapter as the optional entry override', async () => {
    let captured: { entry?: string } | undefined;
    const backend: BackendAdapter = {
      name: 'stub-backend',
      extractRoutes: (async (_root: string, options?: { entry?: string }) => {
        captured = options;
        return { generatedAt: new Date().toISOString(), routes: [] };
      }) as unknown as BackendAdapter['extractRoutes'],
    };
    const gen = makeApiClientGenerator();
    await gen.generate(
      makeCtx({
        projectRoot: projectDir,
        adapters: registryWithBackend(backend),
        flags: { 'api-dir': 'services/api' },
      }),
    );
    expect(captured).toBeDefined();
    expect(captured!.entry).toBe('services/api/src/index.ts');
  });

  it('honors --out (relative paths resolved under projectRoot)', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [],
    };
    const gen = makeApiClientGenerator();
    const result = await gen.generate(
      makeCtx({
        projectRoot: projectDir,
        adapters: registryWithBackend(stubBackend(async () => manifest)),
        flags: { out: 'packages/custom-client/src' },
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.filesWritten![0]).toBe(
      join(projectDir, 'packages/custom-client/src/index.ts'),
    );
  });

  it('returns status: "fail" with the underlying message when extractRoutes throws', async () => {
    const backend = stubBackend(async () => {
      throw new Error('boom');
    });
    const gen = makeApiClientGenerator();
    const result = await gen.generate(
      makeCtx({ projectRoot: projectDir, adapters: registryWithBackend(backend) }),
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('boom');
  });
});
