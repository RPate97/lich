import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';

vi.mock('@levelzero/plugin-playwright', () => ({
  playwrightAdapter: {
    name: 'playwright',
    screenshot: vi.fn(),
    diff: vi.fn(),
  },
}));

import { playwrightAdapter } from '@levelzero/plugin-playwright';
import { screenshotCommand } from '../../src/commands/screenshot';
import { CLIError } from '../../src/errors';

const mockScreenshot = vi.mocked(playwrightAdapter.screenshot);

// A minimal valid PNG (1x1 transparent pixel) for fake adapter output.
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let workDir: string;

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-screenshot-cmd-')));
  mockScreenshot.mockReset();
});

describe('levelzero screenshot (unit)', () => {
  it('exports a command named "screenshot"', () => {
    expect(screenshotCommand.name).toBe('screenshot');
    expect(typeof screenshotCommand.describe).toBe('string');
  });

  it('throws CLIError when no URL argument is provided', async () => {
    await expect(
      screenshotCommand.run({
        cwd: workDir,
        format: 'json',
        args: [],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('throws CLIError when URL is syntactically invalid', async () => {
    await expect(
      screenshotCommand.run({
        cwd: workDir,
        format: 'json',
        args: ['not a url'],
        flags: {},
      }),
    ).rejects.toThrow(CLIError);
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('writes PNG bytes to default screenshot.png in cwd and returns the absolute path', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);

    const result = await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: {},
    });

    expect(mockScreenshot).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockScreenshot.mock.calls[0]!;
    expect(calledUrl).toBe('http://example.com');

    const r = result as { path: string; bytes: number };
    expect(isAbsolute(r.path)).toBe(true);
    expect(r.path).toBe(join(workDir, 'screenshot.png'));
    expect(r.bytes).toBe(FAKE_PNG.length);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path).equals(FAKE_PNG)).toBe(true);
  });

  it('writes to a relative --out path resolved against cwd', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);
    const result = await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: { out: 'shot.png' },
    });
    const r = result as { path: string };
    expect(r.path).toBe(join(workDir, 'shot.png'));
    expect(existsSync(r.path)).toBe(true);
  });

  it('writes to an absolute --out path as-is', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);
    const abs = join(workDir, 'nested', 'snap.png');
    const result = await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: { out: abs },
    });
    const r = result as { path: string };
    expect(r.path).toBe(abs);
    expect(existsSync(abs)).toBe(true);
  });

  it('forwards --width / --height as viewport dims', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);
    await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: { width: '640', height: '480' },
    });
    const [, opts] = mockScreenshot.mock.calls[0]!;
    expect(opts).toMatchObject({ width: 640, height: 480 });
  });

  it('forwards --full-page as fullPage:true', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);
    await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: { 'full-page': true },
    });
    const [, opts] = mockScreenshot.mock.calls[0]!;
    expect(opts).toMatchObject({ fullPage: true });
  });

  it('does not set fullPage when --full-page is absent', async () => {
    mockScreenshot.mockResolvedValueOnce(FAKE_PNG);
    await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: ['http://example.com'],
      flags: {},
    });
    const [, opts] = mockScreenshot.mock.calls[0]!;
    expect((opts as { fullPage?: boolean }).fullPage).toBeUndefined();
  });

  it('throws CLIError when --width is not a positive integer', async () => {
    await expect(
      screenshotCommand.run({
        cwd: workDir,
        format: 'json',
        args: ['http://example.com'],
        flags: { width: 'not-a-number' },
      }),
    ).rejects.toThrow(CLIError);
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('throws CLIError when --height is not a positive integer', async () => {
    await expect(
      screenshotCommand.run({
        cwd: workDir,
        format: 'json',
        args: ['http://example.com'],
        flags: { height: '0' },
      }),
    ).rejects.toThrow(CLIError);
    expect(mockScreenshot).not.toHaveBeenCalled();
  });
});

// Real-browser verification: spin up a tiny http server, screenshot it, verify
// the file on disk is a valid PNG. Skipped if playwright chromium isn't installed.

function detectPlaywrightChromium(): boolean {
  const r = spawnSync(
    'node',
    ['-e', "const { chromium } = require('playwright'); chromium.executablePath();"],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return r.status === 0 && !r.stdout.includes('undefined');
}

const hasChromium = detectPlaywrightChromium();
const describeIfBrowser = hasChromium ? describe : describe.skip;

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#fff"><h1>Hello from screenshot test</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describeIfBrowser('levelzero screenshot (real chromium)', () => {
  it('writes a non-empty PNG (magic bytes) for a real page', async () => {
    // Use the un-mocked adapter for this end-to-end check.
    const { playwrightAdapter: realAdapter } =
      await vi.importActual<typeof import('@levelzero/plugin-playwright')>(
        '@levelzero/plugin-playwright',
      );
    mockScreenshot.mockImplementationOnce((url, opts) => realAdapter.screenshot(url, opts));

    const out = resolve(workDir, 'real.png');
    const result = await screenshotCommand.run({
      cwd: workDir,
      format: 'json',
      args: [`http://127.0.0.1:${port}`],
      flags: { out, width: '400', height: '200' },
    });
    const r = result as { path: string; bytes: number };
    expect(r.path).toBe(out);

    const stat = statSync(out);
    expect(stat.size).toBeGreaterThan(100);

    const bytes = readFileSync(out);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  }, 60_000);
});
