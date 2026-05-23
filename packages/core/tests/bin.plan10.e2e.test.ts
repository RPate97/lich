import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { PNG } from 'pngjs';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p10-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p10-home-')));
  // `ui add` / `ui list` live in `@lich/plugin-shadcn` after LEV-153;
  // the project config must declare the plugin or the commands aren't
  // registered against the dispatcher. After LEV-174 `screenshot` and
  // `visual diff` no longer ship an inline `@lich/plugin-playwright`
  // fallback either — the project config has to declare the playwright
  // plugin to wire a `browser` adapter.
  writeFileSync(
    join(projectDir, 'lich.config.ts'),
    // Plugin order matters here — Bun 1.2.23 segfaults at config evaluation
    // when shadcn is imported before playwright (likely a Bun bug; reversed
    // order works reliably). Both plugins must be present so the dispatcher
    // can resolve the `browser` adapter for `visual diff` and `screenshot`.
    `export default { plugins: ['@lich/plugin-playwright', '@lich/plugin-shadcn'] };`,
  );
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

/**
 * Async spawn that lets the parent event loop continue running while the child
 * executes. Required for tests where the parent serves HTTP that the child
 * must reach (spawnSync would block the parent's event loop and deadlock).
 */
function runAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [BIN, ...args], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

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

function detectPlaywrightChromium(): boolean {
  const r = spawnSync(
    'node',
    ['-e', "const { chromium } = require('playwright'); chromium.executablePath();"],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return r.status === 0 && !r.stdout.includes('undefined');
}

describe('bin: plan-10 commands end-to-end', () => {
  // LEV-168 — pretty is now the default; pass `--json` to parse stdout.
  describe('ui add', () => {
    it('dry-run returns the shadcn command without executing', () => {
      const res = run(['ui', 'add', 'button', '--dry-run', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.executed).toBe(false);
      expect(out.command).toContain('shadcn');
      expect(out.command).toContain('button');
      // default appDir is apps/web
      expect(out.cwd).toContain('apps/web');
    });

    it('--app-dir overrides the default apps/web', () => {
      const res = run(['ui', 'add', 'button', '--dry-run', '--app-dir', 'apps/admin', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.cwd).toContain('apps/admin');
    });

    it('errors when no component arg is given', () => {
      const res = run(['ui', 'add', '--json']);
      expect(res.status).toBe(1);
      const err = JSON.parse(res.stderr);
      expect(err.message).toMatch(/component name/i);
    });
  });

  describe('ui list', () => {
    it('returns empty installed array when apps/web does not exist', () => {
      const res = run(['ui', 'list', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.installed).toEqual([]);
    });
  });

  describe('visual diff', () => {
    it('returns JSON {diffPixels, totalPixels, diffRatio} for two synthetic PNGs', () => {
      const width = 20;
      const height = 10;
      const baselinePath = join(projectDir, 'baseline.png');
      const currentPath = join(projectDir, 'current.png');
      writeFileSync(baselinePath, solidPng(width, height, [255, 0, 0, 255]));
      writeFileSync(currentPath, solidPng(width, height, [0, 0, 255, 255]));

      const res = run(['visual', 'diff', baselinePath, currentPath, '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.totalPixels).toBe(width * height);
      expect(out.diffPixels).toBe(width * height);
      expect(out.diffRatio).toBe(1);
    });

    it('returns diffPixels=0 for identical PNGs', () => {
      const baselinePath = join(projectDir, 'baseline.png');
      const currentPath = join(projectDir, 'current.png');
      const red = solidPng(10, 10, [255, 0, 0, 255]);
      writeFileSync(baselinePath, red);
      writeFileSync(currentPath, red);

      const res = run(['visual', 'diff', baselinePath, currentPath, '--json']);
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.diffPixels).toBe(0);
      expect(out.totalPixels).toBe(100);
      expect(out.diffRatio).toBe(0);
    });
  });
});

// Real-browser verification: spin up a tiny http server, screenshot it through bin.ts,
// verify the file on disk is a valid PNG. Skipped if playwright chromium isn't installed.

const hasChromium = detectPlaywrightChromium();
const describeIfBrowser = hasChromium ? describe : describe.skip;

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#fff"><h1>Plan-10 bin e2e</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describeIfBrowser('bin: plan-10 screenshot (real chromium)', () => {
  it('writes a non-empty PNG starting with PNG magic bytes', async () => {
    const out = join(projectDir, 'shot.png');
    // Use the async runner so the parent's HTTP server (set up in beforeAll)
    // remains responsive while the spawned chromium hits it.
    const res = await runAsync([
      'screenshot',
      `http://127.0.0.1:${port}`,
      '--out',
      out,
      '--width',
      '400',
      '--height',
      '200',
      '--json',
    ]);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.path).toBe(out);
    expect(parsed.bytes).toBeGreaterThan(100);

    expect(existsSync(out)).toBe(true);
    const stat = statSync(out);
    expect(stat.size).toBeGreaterThan(100);

    const bytes = readFileSync(out);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  }, 60_000);
});
