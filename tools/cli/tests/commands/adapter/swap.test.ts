import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, getBuiltinAdapters } from '../../../src/adapters/registry';
import { CLIError } from '../../../src/errors';
import {
  makeAdapterSwapCommand,
  adapterSwapCommand,
} from '../../../src/commands/adapter/swap';

let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-swap-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
});

function run(
  cmd: ReturnType<typeof makeAdapterSwapCommand>,
  cwd: string,
  args: string[],
) {
  return cmd.run({ cwd, format: 'json' as const, args, flags: {} });
}

describe('levelzero adapter swap', () => {
  it('exports a command named "adapter.swap"', () => {
    expect(adapterSwapCommand.name).toBe('adapter.swap');
    expect(typeof adapterSwapCommand.describe).toBe('string');
  });

  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-adapter-swap-outside-')));
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    const err = await run(cmd, outside, ['orm', 'prisma']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).code).toBe('NO_PROJECT');
  });

  it('errors when slot is missing', async () => {
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    await expect(run(cmd, projectDir, [])).rejects.toThrow(/slot/i);
  });

  it('errors when adapter name is missing', async () => {
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    await expect(run(cmd, projectDir, ['orm'])).rejects.toThrow(/name|adapter/i);
  });

  it('errors clearly on unknown slot', async () => {
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    const err = await run(cmd, projectDir, ['bogus', 'prisma']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/slot/i);
    expect((err as CLIError).message).toMatch(/bogus/);
  });

  it('errors clearly on unknown impl for a valid slot', async () => {
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    const err = await run(cmd, projectDir, ['orm', 'drizzle']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toMatch(/adapter|impl/i);
    expect((err as CLIError).message).toMatch(/drizzle/);
  });

  it('writes .levelzero/adapter.json with {slot: name} and returns confirmation', async () => {
    const cmd = makeAdapterSwapCommand({ getRegistry: () => getBuiltinAdapters() });
    const result = (await run(cmd, projectDir, ['orm', 'prisma'])) as {
      ok: boolean;
      slot: string;
      name: string;
      path: string;
    };
    expect(result.ok).toBe(true);
    expect(result.slot).toBe('orm');
    expect(result.name).toBe('prisma');

    const adapterJson = join(projectDir, '.levelzero', 'adapter.json');
    expect(existsSync(adapterJson)).toBe(true);
    expect(result.path).toBe(adapterJson);

    const parsed = JSON.parse(readFileSync(adapterJson, 'utf8'));
    expect(parsed).toEqual({ orm: 'prisma' });
  });

  it('preserves prior slot mappings when swapping a different slot', async () => {
    // Pre-populate the file with an existing mapping that the swap should keep.
    const registry = new AdapterRegistry();
    registry.register({ slot: 'orm', name: 'prisma', impl: {} });
    registry.register({ slot: 'auth', name: 'better-auth', impl: {} });
    const cmd = makeAdapterSwapCommand({ getRegistry: () => registry });

    await run(cmd, projectDir, ['orm', 'prisma']);
    await run(cmd, projectDir, ['auth', 'better-auth']);

    const parsed = JSON.parse(
      readFileSync(join(projectDir, '.levelzero', 'adapter.json'), 'utf8'),
    );
    expect(parsed).toEqual({ orm: 'prisma', auth: 'better-auth' });
  });

  it('overwrites the prior name when swapping the same slot twice', async () => {
    const registry = new AdapterRegistry();
    registry.register({ slot: 'orm', name: 'prisma', impl: {} });
    registry.register({ slot: 'orm', name: 'drizzle', impl: {} });
    const cmd = makeAdapterSwapCommand({ getRegistry: () => registry });

    await run(cmd, projectDir, ['orm', 'prisma']);
    await run(cmd, projectDir, ['orm', 'drizzle']);

    const parsed = JSON.parse(
      readFileSync(join(projectDir, '.levelzero', 'adapter.json'), 'utf8'),
    );
    expect(parsed).toEqual({ orm: 'drizzle' });
  });
});
