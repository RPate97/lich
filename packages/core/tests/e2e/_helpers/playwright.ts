/**
 * E2E harness — playwright wrapper.
 *
 * Two probes ship in this module:
 *
 *   1. `playwrightAndChromiumAvailable()` — SYNCHRONOUS, suitable for
 *      `describe.skipIf` (which vitest evaluates at file-parse time).
 *      Returns `true` only when BOTH the `playwright` package resolves AND
 *      the chromium-headless-shell launcher exists on disk. This is the
 *      gate phase 4 uses — without it the test body would be reached on
 *      hosts that have playwright installed but no browser binaries, and
 *      the wrapped `it.fails(...)` would flip to "expected to fail but
 *      passed" because the soft-skip path doesn't throw.
 *
 *   2. `withBrowser(url, fn)` — async runtime launch. Used inside the
 *      test body. Assumes the sync probe already passed; surfaces a clear
 *      error if `chromium.launch()` somehow still fails (e.g. a stale
 *      `LAUNCHER` path) so the failure mode is "loud red" not "silently
 *      pass via it.fails inversion".
 *
 * Removed in this revision (LEV-198 followup):
 *   - The async `tryLoadPlaywright()` cache and `ensurePlaywrightProbed()`
 *     entry point. Those existed to support the "probe in `beforeAll`,
 *     soft-skip in the test body" pattern, which the C1 fix replaces
 *     with a clean `describe.skipIf` gate.
 *   - `playwrightAvailable()` — superseded by the combined sync probe
 *     below (playwright-without-chromium was always a false-positive gate
 *     for phase 4's purposes).
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

interface PlaywrightModule {
  // We only need the chromium shape we use, not the whole types pkg.
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<{
      newPage(): Promise<unknown>;
      close(): Promise<void>;
    }>;
  };
}

/**
 * Synchronous probe combining both gates:
 *   1. `require.resolve('playwright')` — the package is installed.
 *   2. The chromium browser binary exists in the registry directory.
 *
 * Both are needed: a host can have playwright installed (via
 * `@levelzero/core`'s devDeps) but no chromium downloaded, in which case
 * `chromium.launch()` throws a misleading "Executable doesn't exist"
 * error mid-test. Better to skip cleanly at the describe boundary.
 *
 * The browser-binary check walks the playwright registry directory
 * (`PLAYWRIGHT_BROWSERS_PATH` if set, else `~/.cache/ms-playwright` on
 * Linux/macOS, `%USERPROFILE%\AppData\Local\ms-playwright` on Windows).
 * We accept either `chromium-*` or `chromium_headless_shell-*` because
 * playwright 1.40+ uses the headless-shell flavor by default in tests.
 */
export function playwrightAndChromiumAvailable(): boolean {
  // Step 1: package resolves.
  try {
    const req = createRequire(import.meta.url);
    req.resolve('playwright');
  } catch {
    return false;
  }

  // Step 2: chromium binary is on disk somewhere the playwright launcher
  // will find it. We don't need to know the exact subpath — the presence
  // of any matching directory is sufficient; playwright's own launcher
  // does the precise version-pinned lookup.
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    candidates.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.env.HOME) {
    candidates.push(`${process.env.HOME}/Library/Caches/ms-playwright`); // macOS
    candidates.push(`${process.env.HOME}/.cache/ms-playwright`);          // Linux
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(`${process.env.LOCALAPPDATA}\\ms-playwright`);         // Windows
  }

  for (const root of candidates) {
    if (!existsSync(root)) continue;
    // Cheap directory probe — we don't readdir (would need to filter
    // many entries); we just check the two known browser-folder prefixes
    // at a few likely version offsets. False negatives here only matter
    // for hosts in transitional states (browser partially downloaded);
    // those are rare enough that a clean "skip" is fine.
    try {
      const entries = readdirSync(root);
      const hasChromium = entries.some(
        (e) => e.startsWith('chromium-') || e.startsWith('chromium_headless_shell-'),
      );
      if (hasChromium) return true;
    } catch {
      /* unreadable registry dir; try the next candidate */
    }
  }
  return false;
}

/**
 * Launch a headless chromium browser, navigate to `url`, run `fn(page)`,
 * then close the browser. Returns whatever `fn` returns.
 *
 * Callers MUST gate the surrounding `describe` on
 * `playwrightAndChromiumAvailable()` — this helper assumes both prereqs
 * are present and surfaces any launch failure as a hard error.
 *
 * The browser is launched fresh per call — that's deliberate. The e2e
 * suite only uses playwright in one or two tests, so the cost (~2s
 * launch + close) is small compared to the operational simplicity of
 * not threading a shared browser instance through `beforeAll`/`afterAll`.
 */
export async function withBrowser<T>(
  url: string,
  fn: (page: any) => Promise<T>,
): Promise<T> {
  let mod: PlaywrightModule;
  try {
    mod = (await import('playwright')) as unknown as PlaywrightModule;
  } catch (err) {
    throw new Error(
      `playwright import failed despite sync probe passing: ${(err as Error).message}`,
    );
  }
  const { chromium } = mod;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    // The most common failure here is "browserType.launch: Executable
    // doesn't exist" — playwright is installed but the chromium binary
    // hasn't been downloaded. The sync probe should have caught this;
    // re-surface clearly so the failure mode is "loud red" rather than
    // a flaky pass via `it.fails` inversion.
    throw new Error(
      `playwright chromium failed to launch: ${(err as Error).message}. ` +
        `Run \`bunx playwright install chromium\` to install browser binaries.`,
    );
  }
  try {
    const page = await (browser.newPage as any)();
    await (page as any).goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await fn(page);
  } finally {
    await browser.close().catch(() => {
      // Browser cleanup is best-effort; suppress so we don't mask the
      // original error from `fn`.
    });
  }
}
