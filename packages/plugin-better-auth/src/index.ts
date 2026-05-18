import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Registry,
  type AuthAdapter,
  type Plugin,
  type PluginAPI,
  type PluginContext,
} from '@levelzero/core';
import { betterAuthAdapter } from './adapter';
import { makeCurlCommand } from './curl';

export {
  betterAuthAdapter,
  makeBetterAuth,
  getBetterAuthInstance,
  InvalidSessionError,
  resetBetterAuthCache,
  _resetBetterAuthCacheForTests,
} from './adapter';
export type { BetterAuthInstance } from './adapter';

export {
  getOrCreateUser,
  loginAs,
  verifyAndExtractUserId,
} from './helpers';
export type {
  GetOrCreateUserArgs,
  LoginAsArgs,
  LoginAsResult,
  VerifyArgs,
  VerifyResult,
} from './helpers';

export { makeCurlCommand, curlCommand } from './curl';
export type { CurlResult, MakeCurlCommandOptions } from './curl';

function defaultRegistryPath(): string {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return join(home, '.levelzero', 'registry.json');
}

/**
 * Options for the `@levelzero/plugin-better-auth` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface BetterAuthOptions {
  /** Override the default `'better-auth'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@levelzero/plugin-better-auth` — extracts the Better Auth `AuthAdapter` impl
 * out of `@levelzero/core` (LEV-152), along with the `curl` command that
 * depends on it.
 *
 * Contributes one impl under the `auth` adapter slot:
 *
 *   - `better-auth` — wraps the upstream `better-auth` package, providing
 *     `createUser`, `findUserByEmail`, `signSession`, and `inspectSession`
 *     against a SQLite in-memory store (Postgres support lands later).
 *
 * Activates `better-auth` by default so existing consumers (auth helpers,
 * `curl --as`, etc.) keep observing the same behavior they did before the
 * extraction.
 *
 * Contributes one command:
 *
 *   - `curl` — issues HTTP requests against the api service URL derived from
 *     the running stack's registry entry. With `--as <email>`, mints a session
 *     via `betterAuthAdapter` and attaches the resulting cookie.
 *
 * The command is constructed with a direct reference to `betterAuthAdapter`
 * rather than a `getActive('auth')` lookup on a merged registry. That keeps
 * this plugin self-contained: whatever the user wires up under `auth`
 * elsewhere, `levelzero curl --as` always uses the impl this plugin owns.
 *
 * Wire it into a project by adding it to `levelzero.config.ts`:
 *
 * ```ts
 * import betterAuth from '@levelzero/plugin-better-auth';
 *
 * export default {
 *   plugins: [betterAuth()],
 * };
 * ```
 */
export default function betterAuth(opts: BetterAuthOptions = {}): Plugin<
  'better-auth',
  {
    named: never;
    bulk: never;
  }
> {
  return {
    name: '@levelzero/plugin-better-auth',
    namespace: (opts.namespace ?? 'better-auth') as 'better-auth',
    version: '0.1.0',

    register(api: PluginAPI<'better-auth'>, _ctx: PluginContext): void {
      api.addAdapter('auth', 'better-auth', betterAuthAdapter);
      api.setActiveAdapter('auth', 'better-auth');

      api.addCommand(
        makeCurlCommand({
          getRegistry: () => new Registry(defaultRegistryPath()),
          getAuthAdapter: (): AuthAdapter => betterAuthAdapter,
        }),
      );
    },
  };
}
