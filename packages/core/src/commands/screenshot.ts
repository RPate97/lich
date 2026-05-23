import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CLIError } from '../errors';
import { AdapterRegistry } from '../adapters/registry';
import type { BrowserAdapter, ScreenshotOptions } from '../adapters/browser/types';
import type { Command } from './types';

export interface ScreenshotCommandOptions {
  /**
   * Browser adapter. When omitted, resolved from the AdapterRegistry returned
   * by `getAdapterRegistry` (default `getBuiltinAdapters()`); tests can still
   * pass an explicit stub to bypass the registry entirely.
   */
  adapter?: BrowserAdapter;
  /** AdapterRegistry provider used when `adapter` is omitted. */
  getAdapterRegistry?: () => AdapterRegistry;
}

function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CLIError(
      'CONFIG_INVALID',
      `--${flag} must be a positive integer (got: ${value})`,
      `usage: lich screenshot <url> --${flag} <number>`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CLIError(
      'CONFIG_INVALID',
      `--${flag} must be a positive integer (got: ${value})`,
      `usage: lich screenshot <url> --${flag} <number>`,
    );
  }
  return n;
}

function validateUrl(raw: string): string {
  try {
    // URL constructor throws on syntactically invalid URLs.
    // Accept anything the WHATWG URL parser accepts.
    new URL(raw);
    return raw;
  } catch {
    throw new CLIError(
      'CONFIG_INVALID',
      `invalid URL: ${raw}`,
      'pass an absolute URL like http://localhost:3000',
    );
  }
}

export function makeScreenshotCommand(opts?: ScreenshotCommandOptions): Command {
  const getAdapterRegistry = opts?.getAdapterRegistry;
  // Lazy resolve so an `adapter swap browser ...` between command construction
  // and run-time is honored, and so tests that pass an explicit adapter never
  // touch the global registry. After LEV-174 there is no inline plugin
  // fallback: core no longer imports `@lich/plugin-playwright` directly,
  // so callers MUST either pass an explicit `adapter` (typical for tests) or
  // a `getAdapterRegistry` that resolves a `browser` adapter (typical for the
  // CLI, where `bin.ts` injects the merged plugin-aware registry).
  const resolveAdapter = (): BrowserAdapter => {
    if (opts?.adapter) return opts.adapter;
    if (getAdapterRegistry) return getAdapterRegistry().getActive('browser') as BrowserAdapter;
    throw new CLIError(
      'CONFIG_INVALID',
      'no browser adapter configured for `screenshot`',
      'load `@lich/plugin-playwright` (or another browser plugin) in your lich.config.ts',
    );
  };
  return {
    name: 'screenshot',
    describe: 'Capture a PNG screenshot of a URL and write it to disk',
    async run(ctx) {
      const rawUrl = ctx.args[0];
      if (!rawUrl) {
        throw new CLIError(
          'CONFIG_INVALID',
          'screenshot requires a URL argument',
          'usage: lich screenshot <url> [--out <path>]',
        );
      }
      const url = validateUrl(rawUrl);

      const screenshotOpts: ScreenshotOptions = {};

      const widthFlag = ctx.flags['width'];
      if (typeof widthFlag === 'string') {
        screenshotOpts.width = parsePositiveInt(widthFlag, 'width');
      }

      const heightFlag = ctx.flags['height'];
      if (typeof heightFlag === 'string') {
        screenshotOpts.height = parsePositiveInt(heightFlag, 'height');
      }

      if (ctx.flags['full-page'] === true || ctx.flags['full-page'] === 'true') {
        screenshotOpts.fullPage = true;
      }

      const png = await resolveAdapter().screenshot(url, screenshotOpts);

      const outFlag = ctx.flags['out'];
      const outRaw = typeof outFlag === 'string' ? outFlag : 'screenshot.png';
      const outPath = isAbsolute(outRaw) ? outRaw : resolve(ctx.cwd, outRaw);

      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, png);

      const result = { path: outPath, bytes: png.length };
      if (ctx.format === 'json') return result;
      return `Wrote screenshot to ${outPath} (${png.length} bytes)\n`;
    },
  };
}

export const screenshotCommand = makeScreenshotCommand();
