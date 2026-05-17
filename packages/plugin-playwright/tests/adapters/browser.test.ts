import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { playwrightAdapter } from '../../src/adapters/browser';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';

let server: Server;
let port: number;

function detectPlaywrightChromium(): boolean {
  // Check if chromium is installed; skip tests if not.
  const r = spawnSync(
    'node',
    ['-e', "const { chromium } = require('playwright'); chromium.executablePath();"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  return r.status === 0 && !r.stdout.includes('undefined');
}

const hasChromium = detectPlaywrightChromium();
const describeIfBrowser = hasChromium ? describe : describe.skip;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#fff"><h1 id="t">Hello</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describeIfBrowser('playwrightAdapter (real chromium)', () => {
  it('screenshot returns a PNG buffer of the rendered page', async () => {
    const png = await playwrightAdapter.screenshot(`http://127.0.0.1:${port}`, {
      width: 400,
      height: 200,
    });
    expect(png.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  }, 60_000);

  it('diff against itself returns 0 differing pixels', async () => {
    const png = await playwrightAdapter.screenshot(`http://127.0.0.1:${port}`, {
      width: 200,
      height: 100,
    });
    const d = await playwrightAdapter.diff(png, png);
    expect(d.diffPixels).toBe(0);
    expect(d.diffRatio).toBe(0);
  }, 60_000);

  it('diff throws if image sizes differ', async () => {
    const a = await playwrightAdapter.screenshot(`http://127.0.0.1:${port}`, {
      width: 200,
      height: 100,
    });
    const b = await playwrightAdapter.screenshot(`http://127.0.0.1:${port}`, {
      width: 300,
      height: 100,
    });
    await expect(playwrightAdapter.diff(a, b)).rejects.toThrow(/sizes differ/);
  }, 120_000);
});
