import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { BrowserAdapter, ScreenshotOptions, DiffOptions, DiffResult } from '@levelzero/core';

export const playwrightAdapter: BrowserAdapter = {
  name: 'playwright',

  async screenshot(url: string, opts: ScreenshotOptions = {}): Promise<Buffer> {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({
        viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 },
      });
      const page = await ctx.newPage();
      await page.goto(url, {
        waitUntil: opts.waitFor ?? 'networkidle',
        timeout: opts.timeoutMs ?? 30_000,
      });
      return await page.screenshot({ type: 'png', fullPage: opts.fullPage ?? false });
    } finally {
      await browser.close();
    }
  },

  async diff(a: Buffer, b: Buffer, opts: DiffOptions = {}): Promise<DiffResult> {
    const imgA = PNG.sync.read(a);
    const imgB = PNG.sync.read(b);
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
      throw new Error(
        `image sizes differ: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
      );
    }
    const diffPng = new PNG({ width: imgA.width, height: imgA.height });
    const diffPixels = pixelmatch(
      imgA.data,
      imgB.data,
      diffPng.data,
      imgA.width,
      imgA.height,
      { threshold: opts.threshold ?? 0.1 },
    );
    const totalPixels = imgA.width * imgA.height;
    return { diffPixels, totalPixels, diffRatio: diffPixels / totalPixels };
  },
};
