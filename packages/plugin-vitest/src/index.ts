import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { vitestAdapter } from './adapter';

export { vitestAdapter } from './adapter';

/**
 * `@levelzero/plugin-vitest` — contributes the vitest `TestRunnerAdapter`.
 *
 * Registers one impl under the `test-runner` adapter slot:
 *
 *   - `vitest` — shells out to `vitest run --reporter=json` and parses the
 *     JSON report into a `TestResult` (pass/fail/skip counts + durationMs).
 *
 * Unlike `@levelzero/plugin-portless`, this plugin deliberately does NOT call
 * `api.setActiveAdapter('test-runner', 'vitest')`. The `test-runner` slot is
 * shared with playwright (`levelzero test e2e` uses playwright; `levelzero
 * test unit|integration` uses vitest), and the consuming `test` command picks
 * the impl per-subcommand by name rather than reading `getActive`. Leaving the
 * active impl unset means template config controls which test runner is the
 * default for any future generic `test` invocation that goes through the
 * registry.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * export default {
 *   plugins: ['@levelzero/plugin-vitest'],
 * };
 * ```
 */
const plugin: Plugin = {
  name: '@levelzero/plugin-vitest',
  version: '0.1.0',

  register(api: PluginAPI, _ctx: PluginContext): void {
    api.addAdapter('test-runner', 'vitest', vitestAdapter);
    // Intentionally no setActiveAdapter — see module docstring.
  },
};

export default plugin;
