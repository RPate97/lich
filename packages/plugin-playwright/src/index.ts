import type { Plugin, PluginAPI, PluginContext } from '@lich/core';
import { playwrightAdapter } from './adapters/browser';
import { playwrightTestAdapter } from './adapters/test-runner';

export { playwrightAdapter } from './adapters/browser';
export { playwrightTestAdapter } from './adapters/test-runner';

/**
 * Options for the `@lich/plugin-playwright` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface PlaywrightOptions {
  /** Override the default `'playwright'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@lich/plugin-playwright` — extracts the Playwright `BrowserAdapter` and
 * `TestRunnerAdapter` impls out of `@lich/core`.
 *
 * Contributes two impls across two slots (both backed by the same `playwright`
 * npm package, which is why they ship together):
 *
 *   - `browser` slot, name `playwright` — wraps `chromium.launch()` + `pixelmatch`
 *     to power `lich screenshot` and `lich visual diff`. Activated by
 *     default to preserve pre-extraction behavior for those commands.
 *   - `test-runner` slot, name `playwright` — shells out to
 *     `npx playwright test --reporter=json` and parses the JSON report into a
 *     `TestResult`. NOT auto-activated: the `test-runner` slot is shared with
 *     vitest (`lich test e2e` uses playwright; `lich test unit|
 *     integration` uses vitest), and the consuming `test` command picks the
 *     impl per-subcommand by name rather than reading `getActive`. Leaving the
 *     active impl unset means template config controls which test runner is
 *     the default for any future generic `test` invocation that goes through
 *     the registry.
 *
 * Wire it into a project by adding it to `lich.config.ts`:
 *
 * ```ts
 * import playwright from '@lich/plugin-playwright';
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
    name: '@lich/plugin-playwright',
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
