import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import { typedClientFrontendAdapter } from '../src/adapter';
import type { FrontendAdapter, RouteManifest } from '@levelzero/core';

describe('typedClientFrontendAdapter', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'lev-typed-client-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('exposes the FrontendAdapter interface', () => {
    const a: FrontendAdapter = typedClientFrontendAdapter;
    expect(a.name).toBe('typed-client');
    expect(typeof a.generateClient).toBe('function');
  });

  it('generates one async function per route', async () => {
    const routes: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [
        { method: 'GET', path: '/api/health' },
        { method: 'GET', path: '/api/users/:id' },
        { method: 'POST', path: '/api/users' },
      ],
    };

    const result = await typedClientFrontendAdapter.generateClient({ routes, outDir });

    expect(result.files).toEqual([join(outDir, 'index.ts')]);

    const written = await readFile(join(outDir, 'index.ts'), 'utf8');

    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile('index.ts', written);

    const fns = sf.getFunctions().filter((f) => f.isExported() && f.isAsync());
    expect(fns).toHaveLength(3);

    const names = fns.map((f) => f.getName());
    expect(names).toContain('getApiHealth');
    expect(names).toContain('getApiUsersById');
    expect(names).toContain('postApiUsers');

    // Each function takes an ApiClient arg
    for (const fn of fns) {
      const params = fn.getParameters();
      expect(params).toHaveLength(1);
      expect(params[0]!.getType().getText()).toContain('ApiClient');
    }

    // ApiClient interface is exported
    const iface = sf.getInterface('ApiClient');
    expect(iface).toBeDefined();
    expect(iface!.isExported()).toBe(true);
  });

  it('creates the outDir if it does not already exist', async () => {
    const nested = join(outDir, 'nested', 'deep');
    const routes: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [{ method: 'GET', path: '/api/ping' }],
    };

    const result = await typedClientFrontendAdapter.generateClient({ routes, outDir: nested });
    expect(result.files).toEqual([join(nested, 'index.ts')]);

    const written = await readFile(join(nested, 'index.ts'), 'utf8');
    expect(written).toContain('getApiPing');
  });

  it('handles an empty manifest by emitting only the ApiClient interface', async () => {
    const routes: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [],
    };

    const result = await typedClientFrontendAdapter.generateClient({ routes, outDir });
    const written = await readFile(join(outDir, 'index.ts'), 'utf8');

    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile('index.ts', written);

    expect(sf.getFunctions()).toHaveLength(0);
    expect(sf.getInterface('ApiClient')).toBeDefined();
    expect(result.files).toEqual([join(outDir, 'index.ts')]);
  });
});
