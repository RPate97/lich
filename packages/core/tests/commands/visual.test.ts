import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { visualDiffCommand } from '../../src/commands/visual';
import { CLIError } from '../../src/errors';

/** Build a PNG buffer filled with the given RGBA color. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rgba[0]!;
      png.data[idx + 1] = rgba[1]!;
      png.data[idx + 2] = rgba[2]!;
      png.data[idx + 3] = rgba[3]!;
    }
  }
  return PNG.sync.write(png);
}

let projectDir: string;
let baselinePath: string;
let currentPath: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-visual-')));
  baselinePath = join(projectDir, 'baseline.png');
  currentPath = join(projectDir, 'current.png');
});

describe('levelzero visual diff', () => {
  it('exports a command named "visual.diff"', () => {
    expect(visualDiffCommand.name).toBe('visual.diff');
    expect(typeof visualDiffCommand.describe).toBe('string');
  });

  it('returns diffPixels=0 for identical PNGs', async () => {
    const red = solidPng(20, 10, [255, 0, 0, 255]);
    writeFileSync(baselinePath, red);
    writeFileSync(currentPath, red);

    const result = (await visualDiffCommand.run({
      cwd: projectDir,
      format: 'json',
      args: [baselinePath, currentPath],
      flags: {},
    })) as { diffPixels: number; totalPixels: number; diffRatio: number };

    expect(result.diffPixels).toBe(0);
    expect(result.totalPixels).toBe(200);
    expect(result.diffRatio).toBe(0);
  });

  it('returns diffPixels equal to total area for fully different PNGs', async () => {
    const width = 30;
    const height = 20;
    const red = solidPng(width, height, [255, 0, 0, 255]);
    const blue = solidPng(width, height, [0, 0, 255, 255]);
    writeFileSync(baselinePath, red);
    writeFileSync(currentPath, blue);

    const result = (await visualDiffCommand.run({
      cwd: projectDir,
      format: 'json',
      args: [baselinePath, currentPath],
      flags: {},
    })) as { diffPixels: number; totalPixels: number; diffRatio: number };

    expect(result.totalPixels).toBe(width * height);
    expect(result.diffPixels).toBe(width * height);
    expect(result.diffRatio).toBe(1);
  });

  it('accepts relative paths resolved against cwd', async () => {
    const red = solidPng(5, 5, [255, 0, 0, 255]);
    writeFileSync(baselinePath, red);
    writeFileSync(currentPath, red);

    const result = (await visualDiffCommand.run({
      cwd: projectDir,
      format: 'json',
      args: ['baseline.png', 'current.png'],
      flags: {},
    })) as { diffPixels: number };

    expect(result.diffPixels).toBe(0);
  });

  it('throws CLIError when baseline path is missing', async () => {
    await expect(
      visualDiffCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
  });

  it('throws CLIError when current path is missing', async () => {
    writeFileSync(baselinePath, solidPng(5, 5, [255, 0, 0, 255]));
    await expect(
      visualDiffCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [baselinePath],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
  });

  it('throws CLIError when a PNG file does not exist on disk', async () => {
    writeFileSync(baselinePath, solidPng(5, 5, [255, 0, 0, 255]));
    let caught: unknown;
    try {
      await visualDiffCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [baselinePath, join(projectDir, 'does-not-exist.png')],
        flags: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CLIError);
    expect((caught as Error).message).toContain('does-not-exist.png');
  });

  it('throws when image dimensions differ (propagated from adapter)', async () => {
    writeFileSync(baselinePath, solidPng(10, 10, [255, 0, 0, 255]));
    writeFileSync(currentPath, solidPng(20, 10, [255, 0, 0, 255]));
    await expect(
      visualDiffCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [baselinePath, currentPath],
        flags: {},
      }),
    ).rejects.toThrow(/sizes differ/);
  });

  it('throws CLIError when --threshold is exceeded (diffPixels > N)', async () => {
    const width = 10;
    const height = 10; // total 100 pixels of pure difference
    writeFileSync(baselinePath, solidPng(width, height, [255, 0, 0, 255]));
    writeFileSync(currentPath, solidPng(width, height, [0, 0, 255, 255]));

    let caught: unknown;
    try {
      await visualDiffCommand.run({
        cwd: projectDir,
        format: 'json',
        args: [baselinePath, currentPath],
        flags: { threshold: '10' },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CLIError);
    expect((caught as Error).message).toMatch(/threshold/i);
    expect((caught as Error).message).toContain('100');
  });

  it('does not throw when diffPixels <= --threshold', async () => {
    const red = solidPng(10, 10, [255, 0, 0, 255]);
    writeFileSync(baselinePath, red);
    writeFileSync(currentPath, red);

    const result = (await visualDiffCommand.run({
      cwd: projectDir,
      format: 'json',
      args: [baselinePath, currentPath],
      flags: { threshold: '0' },
    })) as { diffPixels: number };
    expect(result.diffPixels).toBe(0);
  });

  it('--alpha is forwarded to the adapter as DiffOptions.threshold', async () => {
    // Mock the adapter to verify the option propagation.
    vi.resetModules();
    vi.doMock('@levelzero/plugin-playwright', () => ({
      playwrightAdapter: {
        name: 'playwright',
        screenshot: vi.fn(),
        diff: vi.fn(async () => ({ diffPixels: 0, totalPixels: 4, diffRatio: 0 })),
      },
    }));
    const { visualDiffCommand: cmd } = await import('../../src/commands/visual');
    const { playwrightAdapter } = await import('@levelzero/plugin-playwright');

    const px = solidPng(2, 2, [255, 0, 0, 255]);
    writeFileSync(baselinePath, px);
    writeFileSync(currentPath, px);

    await cmd.run({
      cwd: projectDir,
      format: 'json',
      args: [baselinePath, currentPath],
      flags: { alpha: '0.5' },
    });

    expect(playwrightAdapter.diff).toHaveBeenCalledTimes(1);
    const calledOpts = (playwrightAdapter.diff as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![2];
    expect(calledOpts).toMatchObject({ threshold: 0.5 });

    vi.doUnmock('@levelzero/plugin-playwright');
    vi.resetModules();
  });
});
