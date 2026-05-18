import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { playwrightAdapter } from './adapters/browser';
import { playwrightTestAdapter } from './adapters/test-runner';

export { playwrightAdapter } from './adapters/browser';
export { playwrightTestAdapter } from './adapters/test-runner';

/**
 * Options for the `@levelzero/plugin-playwright` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface PlaywrightOptions {
  /** Override the default `'playwright'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-playwright` — extracts the Playwright `BrowserAdapter` and
 * `TestRunnerAdapter` impls out of `@levelzero/core`.
 *
 * Contributes two impls across two slots (both backed by the same `playwright`
 * npm package, which is why they ship together):
 *
 *   - `browser` slot, name `playwright` — wraps `chromium.launch()` + `pixelmatch`
 *     to power `levelzero screenshot` and `levelzero visual diff`. Activated by
 *     default to preserve pre-extraction behavior for those commands.
 *   - `test-runner` slot, name `playwright` — shells out to
 *     `npx playwright test --reporter=json` and parses the JSON report into a
 *     `TestResult`. NOT auto-activated: the `test-runner` slot is shared with
 *     vitest (`levelzero test e2e` uses playwright; `levelzero test unit|
 *     integration` uses vitest), and the consuming `test` command picks the
 *     impl per-subcommand by name rather than reading `getActive`. Leaving the
 *     active impl unset means template config controls which test runner is
 *     the default for any future generic `test` invocation that goes through
 *     the registry.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import playwright from '@levelzero/plugin-playwright';
 *
 * export default {
 *   plugins: [playwright()],
 * };
 * ```
 */
export default function playwright(opts: PlaywrightOptions = {}): Plugin<
  'playwright',
  {
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-playwright',
    namespace: (opts.namespace ?? 'playwright') as 'playwright',
    version: '0.1.0',

    register(api: PluginAPI<'playwright'>, _ctx: PluginContext): void {
      api.addAdapter('browser', 'playwright', playwrightAdapter);
      api.setActiveAdapter('browser', 'playwright');
      api.addAdapter('test-runner', 'playwright', playwrightTestAdapter);
      // Intentionally no setActiveAdapter for the test-runner slot — see module
      // docstring. vitest also lives in that slot.
    },
  };
}
