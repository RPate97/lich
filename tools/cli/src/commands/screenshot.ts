import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CLIError } from '../errors';
import { playwrightAdapter } from '../adapters/browser/playwright';
import type { BrowserAdapter, ScreenshotOptions } from '../adapters/browser/types';
import type { Command } from './types';

export interface ScreenshotCommandOptions {
  /** Override the browser adapter; defaults to playwrightAdapter. Tests can inject mocks. */
  adapter?: BrowserAdapter;
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
  const adapter = opts?.adapter ?? playwrightAdapter;
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

      const png = await adapter.screenshot(url, screenshotOpts);

      const outFlag = ctx.flags['out'];
      const outRaw = typeof outFlag === 'string' ? outFlag : 'screenshot.png';
      const outPath = isAbsolute(outRaw) ? outRaw : resolve(ctx.cwd, outRaw);

      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, png);

      return { path: outPath, bytes: png.length };
    },
  };
}

export const screenshotCommand = makeScreenshotCommand();
