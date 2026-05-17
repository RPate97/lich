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
  /** 0-1; pixel similarity threshold passed to pixelmatch. Default 0.1. */
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
