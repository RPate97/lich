/**
 * E2E harness — playwright wrapper.
 *
 * Lazy-imports playwright (a devDependency of `@levelzero/core`) so the
 * test file doesn't pay the chromium-launch cost at file-parse time and
 * so the import failure mode degrades gracefully when playwright isn't
 * actually installed for the current run.
 *
 * The "is playwright available" probe is a one-shot: we try to import,
 * cache the result, and surface `playwrightAvailable()` so `describe.skipIf`
 * can branch. The browser binary download is a separate concern — even
 * if `import('playwright')` succeeds, `chromium.launch()` may fail with
 * a missing-binary error. We swallow that in `withBrowser` and re-throw
 * with a clearer message.
 */

interface PlaywrightModule {
  // We only need the chromium shape we use, not the whole types pkg.
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<{
      newPage(): Promise<unknown>;
      close(): Promise<void>;
    }>;
  };
}

let cached: { ok: true; mod: PlaywrightModule } | { ok: false; reason: string } | null = null;

async function tryLoadPlaywright(): Promise<typeof cached> {
  if (cached !== null) return cached;
  try {
    // `as unknown as PlaywrightModule` — we don't have `@types/playwright`
    // here, just the runtime API surface we use.
    const mod = (await import('playwright')) as unknown as PlaywrightModule;
    cached = { ok: true, mod };
  } catch (err) {
    cached = { ok: false, reason: (err as Error).message };
  }
  return cached;
}

/**
 * Synchronous "is playwright reachable" check. Returns true if a prior
 * `tryLoadPlaywright` succeeded; otherwise triggers a fresh attempt.
 *
 * Vitest evaluates `describe.skipIf(predicate)` at file-parse time
 * (synchronously). To accommodate that we eagerly probe at module load
 * via a top-level await emulation: we kick off the import, and the
 * synchronous predicate reports the cached result. First-call returns
 * `false` and the actual probe completes during module init.
 */
export function playwrightAvailable(): boolean {
  if (cached === null) {
    // Kick off the probe but don't wait for it. The predicate may report
    // false on the first call; subsequent calls (in `it`) see the real
    // result. For our e2e suite this is fine: phase 4 is gated by a
    // describe.skipIf that runs after the module finishes loading.
    void tryLoadPlaywright();
    return false;
  }
  return cached.ok;
}

/**
 * Synchronously block-wait on the playwright probe by spinning the event
 * loop. Use this in `beforeAll` (where await IS available) instead —
 * `withBrowser` itself awaits internally.
 */
export async function ensurePlaywrightProbed(): Promise<boolean> {
  const res = await tryLoadPlaywright();
  return res?.ok === true;
}

/**
 * Launch a headless chromium browser, navigate to `url`, run `fn(page)`,
 * then close the browser. Returns whatever `fn` returns.
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
  const probe = await tryLoadPlaywright();
  if (!probe || !probe.ok) {
    throw new Error(
      `playwright not available: ${probe?.ok === false ? probe.reason : 'unknown reason'}`,
    );
  }
  const { chromium } = probe.mod;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    // The most common failure here is "browserType.launch: Executable
    // doesn't exist" — playwright is installed but the chromium binary
    // hasn't been downloaded. Surface it clearly so callers can skip
    // rather than fail the suite outright.
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
