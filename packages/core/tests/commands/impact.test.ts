import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/impact/graph', () => ({
  reverseDeps: vi.fn(),
}));

import { reverseDeps } from '../../src/impact/graph';
import { impactCommand } from '../../src/commands/impact';
import { CLIError } from '../../src/errors';

const mockReverseDeps = vi.mocked(reverseDeps);

let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-impact-cmd-')));
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'target.ts'), 'export const X = 1;\n');
  mockReverseDeps.mockReset();
});

describe('levelzero impact', () => {
  it('exports a command named "impact"', () => {
    expect(impactCommand.name).toBe('impact');
    expect(typeof impactCommand.describe).toBe('string');
  });

  it('calls reverseDeps with the absolute path and default tsconfig + returns dependents as JSON array', async () => {
    const dependents = [
      join(projectDir, 'src', 'a.ts'),
      join(projectDir, 'src', 'b.ts'),
    ];
    mockReverseDeps.mockResolvedValueOnce(dependents);

    const result = await impactCommand.run({
      cwd: projectDir,
      format: 'json',
      args: ['src/target.ts'],
      flags: {},
    });

    expect(mockReverseDeps).toHaveBeenCalledTimes(1);
    const [calledTarget, calledOpts] = mockReverseDeps.mock.calls[0]!;
    expect(calledTarget).toBe(join(projectDir, 'src', 'target.ts'));
    expect(calledOpts).toMatchObject({ projectRoot: projectDir });
    expect(result).toEqual(dependents);
  });

  it('accepts an already-absolute path', async () => {
    mockReverseDeps.mockResolvedValueOnce([]);
    const abs = join(projectDir, 'src', 'target.ts');
    await impactCommand.run({
      cwd: projectDir,
      format: 'json',
      args: [abs],
      flags: {},
    });
    expect(mockReverseDeps.mock.calls[0]![0]).toBe(abs);
  });

  it('--tsconfig overrides the tsconfig path (projectRoot is derived from its directory)', async () => {
    const customDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-impact-tsconf-')));
    writeFileSync(join(customDir, 'tsconfig.custom.json'), JSON.stringify({ compilerOptions: {} }));
    mockReverseDeps.mockResolvedValueOnce([]);

    await impactCommand.run({
      cwd: projectDir,
      format: 'json',
      args: ['src/target.ts'],
      flags: { tsconfig: join(customDir, 'tsconfig.custom.json') },
    });

    const [, calledOpts] = mockReverseDeps.mock.calls[0]!;
    expect((calledOpts as { projectRoot: string }).projectRoot).toBe(customDir);
  });

  it('resolves a relative --tsconfig against cwd', async () => {
    writeFileSync(join(projectDir, 'tsconfig.alt.json'), JSON.stringify({ compilerOptions: {} }));
    mockReverseDeps.mockResolvedValueOnce([]);

    await impactCommand.run({
      cwd: projectDir,
      format: 'json',
      args: ['src/target.ts'],
      flags: { tsconfig: 'tsconfig.alt.json' },
    });

    const [, calledOpts] = mockReverseDeps.mock.calls[0]!;
    expect((calledOpts as { projectRoot: string }).projectRoot).toBe(projectDir);
  });

  it('throws CLIError when the target path does not exist', async () => {
    await expect(
      impactCommand.run({
        cwd: projectDir,
        format: 'json',
        args: ['src/does-not-exist.ts'],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
    expect(mockReverseDeps).not.toHaveBeenCalled();
  });

  it('CLIError on missing file mentions the path', async () => {
    let caught: unknown;
    try {
      await impactCommand.run({
        cwd: projectDir,
        format: 'json',
        args: ['src/missing-file.ts'],
        flags: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CLIError);
    expect((caught as Error).message).toContain('missing-file.ts');
  });

  it('throws CLIError when no path argument is provided', async () => {
    await expect(
      impactCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
    expect(mockReverseDeps).not.toHaveBeenCalled();
  });

  // LEV-168 — pretty mode is now the default. The command renders the
  // dependent list as one-path-per-line text; --json returns the raw array.
  it('pretty mode renders the dependent list as text', async () => {
    const dependents = [
      join(projectDir, 'src', 'a.ts'),
      join(projectDir, 'src', 'b.ts'),
    ];
    mockReverseDeps.mockResolvedValueOnce(dependents);
    const result = await impactCommand.run({
      cwd: projectDir,
      format: 'pretty',
      args: ['src/target.ts'],
      flags: {},
    });
    expect(typeof result).toBe('string');
    expect(result as string).toContain(dependents[0]!);
    expect(result as string).toContain(dependents[1]!);
  });

  it('pretty mode renders a friendly message when there are no dependents', async () => {
    mockReverseDeps.mockResolvedValueOnce([]);
    const result = await impactCommand.run({
      cwd: projectDir,
      format: 'pretty',
      args: ['src/target.ts'],
      flags: {},
    });
    expect(result).toBe('no reverse dependencies\n');
  });
});
