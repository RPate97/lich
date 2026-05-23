/**
 * BrowserAdapter — pluggable interface for the headless-browser slot.
 *
 * Hypothetical alternative implementations:
 *   - Playwright   (current default; ships in `@lich/plugin-playwright`)
 *   - Puppeteer    (Chromium-only headless driver)
 *   - WebDriverIO  (WebDriver protocol; supports many browsers + mobile)
 *   - Cypress      (in-browser runner; would need a shim for headless capture)
 *   - HtmlRR       (snapshot-only impls for env-without-Chromium tests)
 *
 * Consumer-POV: callers want "a PNG of this URL" and "the pixel diff
 * between two PNGs". They don't care which engine, which protocol, or
 * which CSS rendering quirks are involved — those stay inside the impl.
 *
 * Returning a `Buffer` (raw PNG bytes) keeps the contract decoupled from
 * any one library's image-handle type (no `playwright.Buffer`, no
 * `Puppeteer.ScreenshotResult`). The diff is similarly defined in terms
 * of pixel counts only — pixelmatch, odiff, looks-same, or a custom
 * impl can all satisfy the contract.
 */

export interface ScreenshotOptions {
  /** Viewport width × height. Default 1280x800. */
  width?: number;
  height?: number;
  /** Wait until this load state before screenshotting. Default 'networkidle'. */
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Hard timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Capture the full scrollable page height instead of the viewport. Default false. */
  fullPage?: boolean;
}

export interface DiffOptions {
  /** 0-1; pixel similarity threshold. Default 0.1. Semantics are impl-defined but all impls SHOULD treat 0 as exact-match and 1 as everything-counts. */
  threshold?: number;
}

export interface DiffResult {
  /** Number of differing pixels. */
  diffPixels: number;
  /** Total pixels in the reference image. */
  totalPixels: number;
  /** diffPixels / totalPixels. */
  diffRatio: number;
}

export interface BrowserAdapter {
  name: string;
  /** Returns a PNG image buffer of the rendered page at `url`. */
  screenshot(url: string, opts?: ScreenshotOptions): Promise<Buffer>;
  /** Diff two PNG buffers. */
  diff(a: Buffer, b: Buffer, opts?: DiffOptions): Promise<DiffResult>;
}
