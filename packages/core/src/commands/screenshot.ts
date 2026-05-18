import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CLIError } from '../errors';
import { AdapterRegistry } from '../adapters/registry';
import { playwrightAdapter } from '@levelzero/plugin-playwright';
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
      `usage: levelzero screenshot <url> --${flag} <number>`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CLIError(
      'CONFIG_INVALID',
      `--${flag} must be a positive integer (got: ${value})`,
      `usage: levelzero screenshot <url> --${flag} <number>`,
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
  // touch the global registry. When no registry provider is supplied, fall back
  // to the playwright adapter imported directly from `@levelzero/plugin-playwright`
  // (the post-LEV-156 default; the `browser` slot is no longer populated by
  // `getBuiltinAdapters()` and is only registered when the plugin is loaded
  // via `levelzero.config.ts`).
  const resolveAdapter = (): BrowserAdapter => {
    if (opts?.adapter) return opts.adapter;
    if (getAdapterRegistry) return getAdapterRegistry().getActive('browser') as BrowserAdapter;
    return playwrightAdapter;
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
          'usage: levelzero screenshot <url> [--out <path>]',
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
