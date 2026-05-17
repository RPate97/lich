import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from '../../../src/errors';
import {
  genClientCommand,
  makeGenClientCommand,
} from '../../../src/commands/gen/client';
import type {
  BackendAdapter,
  RouteManifest,
} from '../../../src/adapters/backend/types';
import type {
  FrontendAdapter,
  GenerateClientInput,
} from '../../../src/adapters/frontend/types';

function stubBackend(
  impl: (projectRoot: string) => Promise<RouteManifest>,
): BackendAdapter {
  return {
    name: 'stub-backend',
    extractRoutes: vi.fn(impl) as unknown as BackendAdapter['extractRoutes'],
  };
}

function stubFrontend(
  impl: (input: GenerateClientInput) => Promise<{ files: string[] }>,
): FrontendAdapter {
  return {
    name: 'stub-frontend',
    generateClient: vi.fn(
      impl,
    ) as unknown as FrontendAdapter['generateClient'],
  };
}

let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-gen-client-proj-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

describe('levelzero gen client', () => {
  it('exports a command named "gen.client"', () => {
    expect(genClientCommand.name).toBe('gen.client');
    expect(typeof genClientCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'lz-gen-client-outside-')),
    );
    const backendAdapter = stubBackend(async () => ({
      generatedAt: new Date().toISOString(),
      routes: [],
    }));
    const frontendAdapter = stubFrontend(async () => ({ files: [] }));
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
    expect(backendAdapter.extractRoutes).not.toHaveBeenCalled();
    expect(frontendAdapter.generateClient).not.toHaveBeenCalled();
  });

  it('calls backend.extractRoutes with the resolved project root', async () => {
    let capturedRoot: string | undefined;
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [{ method: 'GET', path: '/api/health' }],
    };
    const backendAdapter = stubBackend(async (root) => {
      capturedRoot = root;
      return manifest;
    });
    const frontendAdapter = stubFrontend(async () => ({
      files: [join(projectDir, 'packages/api-client/src/index.ts')],
    }));
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} });

    expect(backendAdapter.extractRoutes).toHaveBeenCalledTimes(1);
    expect(capturedRoot).toBe(projectDir);
  });

  it('passes the manifest through to frontend.generateClient with the default outDir', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [
        { method: 'GET', path: '/api/health' },
        { method: 'POST', path: '/api/users' },
      ],
    };
    const backendAdapter = stubBackend(async () => manifest);
    let captured: GenerateClientInput | undefined;
    const expectedFile = join(projectDir, 'packages/api-client/src/index.ts');
    const frontendAdapter = stubFrontend(async (input) => {
      captured = input;
      return { files: [expectedFile] };
    });
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { generatedFiles: string[] };

    expect(frontendAdapter.generateClient).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.routes).toBe(manifest);
    expect(captured!.outDir).toBe(
      join(projectDir, 'packages/api-client/src'),
    );
    expect(result.generatedFiles).toEqual([expectedFile]);
  });

  it('honors the --out flag (resolved relative to the project root)', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [],
    };
    const backendAdapter = stubBackend(async () => manifest);
    let captured: GenerateClientInput | undefined;
    const frontendAdapter = stubFrontend(async (input) => {
      captured = input;
      return { files: [join(input.outDir, 'index.ts')] };
    });
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { out: 'packages/custom-client/src' },
    })) as { generatedFiles: string[] };

    expect(captured!.outDir).toBe(
      join(projectDir, 'packages/custom-client/src'),
    );
    expect(result.generatedFiles).toEqual([
      join(projectDir, 'packages/custom-client/src/index.ts'),
    ]);
  });

  it('honors an absolute --out path without re-rooting it', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [],
    };
    const backendAdapter = stubBackend(async () => manifest);
    let captured: GenerateClientInput | undefined;
    const absOut = realpathSync(
      mkdtempSync(join(tmpdir(), 'lz-gen-client-absout-')),
    );
    const frontendAdapter = stubFrontend(async (input) => {
      captured = input;
      return { files: [join(input.outDir, 'index.ts')] };
    });
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { out: absOut },
    });

    expect(captured!.outDir).toBe(absOut);
  });

  it('honors the --api-dir flag by passing a custom entry to the backend adapter', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [],
    };
    let capturedOptions:
      | { entry?: string }
      | undefined;
    const backendAdapter: BackendAdapter & {
      extractRoutes(
        projectRoot: string,
        options?: { entry?: string },
      ): Promise<RouteManifest>;
    } = {
      name: 'stub-backend',
      extractRoutes: vi.fn(
        async (_root: string, options?: { entry?: string }) => {
          capturedOptions = options;
          return manifest;
        },
      ) as unknown as BackendAdapter['extractRoutes'],
    };
    const frontendAdapter = stubFrontend(async (input) => ({
      files: [join(input.outDir, 'index.ts')],
    }));
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: { 'api-dir': 'services/api' },
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.entry).toBe('services/api/src/index.ts');
  });

  it('returns { generatedFiles } sourced from the frontend adapter result', async () => {
    const manifest: RouteManifest = {
      generatedAt: new Date().toISOString(),
      routes: [{ method: 'GET', path: '/api/ping' }],
    };
    const backendAdapter = stubBackend(async () => manifest);
    const writtenFiles = [
      join(projectDir, 'packages/api-client/src/index.ts'),
      join(projectDir, 'packages/api-client/src/extra.ts'),
    ];
    const frontendAdapter = stubFrontend(async () => ({ files: writtenFiles }));
    const cmd = makeGenClientCommand({ backendAdapter, frontendAdapter });

    const result = (await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [],
      flags: {},
    })) as { generatedFiles: string[] };

    expect(result.generatedFiles).toEqual(writtenFiles);
  });

  it('default export wires up the built-in registry lazily (smoke check)', () => {
    // The frontend adapter is no longer built in (extracted to
    // `@levelzero/plugin-typed-client`); we just assert the command exists —
    // the actual frontend resolution happens at runtime against whichever
    // registry the dispatch layer hands in.
    expect(typeof genClientCommand.run).toBe('function');
  });
});
