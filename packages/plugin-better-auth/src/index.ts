import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLIError,
  EnvSourceRegistry,
  Registry,
  resolveStackContext,
  type AuthAdapter,
  type AuthContext,
  type CommandContext,
  type Plugin,
  type PluginAPI,
  type PluginContext,
} from '@lich/core';
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
  const home = process.env['LICH_HOME'] ?? homedir();
  return join(home, '.lich', 'registry.json');
}

/**
 * Resolve `DATABASE_URL` for the active worktree from the EnvSource registry.
 *
 * Mirrors `plugin-prisma`'s `resolveDatabaseUrl` (LEV-171) — the contract is:
 * scan named sources for one whose `name === 'url'` and whose declared
 * `protocol === 'postgres'`. That pair uniquely identifies "the connection
 * string a postgres-shaped DB plugin published" without coupling this plugin
 * to a specific namespace. We keep the lookup local to plugin-better-auth
 * to avoid a cross-package dep on plugin-prisma.
 */
async function resolveDatabaseUrl(input: {
  envSourceRegistry: EnvSourceRegistry | undefined;
  cmdCtx: CommandContext;
}): Promise<string> {
  if (!input.envSourceRegistry) {
    throw new CLIError(
      'INTERNAL',
      'EnvSource registry not available to plugin-better-auth curl',
      'this command requires the dispatch-wired CommandContext (post-bootPlugins).',
    );
  }
  const stackCtx = await resolveStackContext(input.cmdCtx.cwd);
  // We also need the running stack's port map so the source's host() resolver
  // can substitute the host port. Pull it from the per-worktree registry.
  const wtRegistry = new Registry(defaultRegistryPath());
  const entry = await wtRegistry.get(stackCtx.worktreeKey);
  const urlSrc = input.envSourceRegistry.findFirstNamed(
    (e) => e.source.protocol === 'postgres' && e.name === 'url',
  );
  if (!urlSrc) {
    throw new CLIError(
      'NO_PROJECT',
      'no postgres EnvSource active',
      'add a postgres-protocol DB plugin to your `lich.config.ts` plugins list so a ' +
        '`<ns>.url` source with `protocol: "postgres"` is registered.',
    );
  }
  return urlSrc.source.host({
    ports: entry?.ports ?? {},
    projectRoot: stackCtx.worktreePath,
    worktreeKey: stackCtx.worktreeKey,
    consumerContext: 'host',
  });
}

/**
 * Options for the `@lich/plugin-better-auth` factory. The `namespace`
 * override exists so multi-instance setups can co-exist.
 */
export interface BetterAuthOptions {
  /** Override the default `'better-auth'` namespace for multi-instance use. */
  namespace?: string;
}

/**
 * `@lich/plugin-better-auth` — extracts the Better Auth `AuthAdapter` impl
 * out of `@lich/core` (LEV-152), along with the `curl` command that
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
 * elsewhere, `lich curl --as` always uses the impl this plugin owns.
 *
 * Wire it into a project by adding it to `lich.config.ts`:
 *
 * ```ts
 * import betterAuth from '@lich/plugin-better-auth';
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
    name: '@lich/plugin-better-auth',
    namespace: (opts.namespace ?? 'better-auth') as 'better-auth',
    version: '0.1.0',

    register(api: PluginAPI<'better-auth'>, ctx: PluginContext): void {
      api.addAdapter('auth', 'better-auth', betterAuthAdapter);
      api.setActiveAdapter('auth', 'better-auth');

      // LEV-173 composability wiring: capture the host closures here so they
      // resolve at command-run time (gives plugins that load AFTER us a
      // chance to set the active impl / publish env sources). The closures
      // are threaded through the curl command's AuthContext so
      // `--as alice@example.com` lands the user in whichever database the
      // active ORM owns, not in a separate sqlite file. When no ORM is
      // active, the in-memory sqlite test-mode fallback (NODE_ENV=test)
      // still applies.
      const getActiveOrm = ctx.getActiveOrm;
      const getEnvSourceRegistry = ctx.getEnvSourceRegistry;

      const buildAuthCtx = async (cmdCtx: CommandContext): Promise<AuthContext> => {
        const secret =
          process.env['LICH_AUTH_SECRET'] ?? 'test-secret-32-chars-min-length-aaaa';
        const orm = getActiveOrm?.();
        // No ORM → keep the legacy in-memory sqlite ctx. NODE_ENV=test (the
        // test runner's default) is what unlocks the fallback inside the
        // adapter.
        if (!orm) {
          return { databaseUrl: 'sqlite::memory:', secret, getActiveOrm };
        }
        // ORM active → resolve the real DATABASE_URL via the EnvSource
        // registry, same lookup plugin-prisma's db.* commands use.
        const databaseUrl = await resolveDatabaseUrl({
          envSourceRegistry: getEnvSourceRegistry?.(),
          cmdCtx,
        });
        return { databaseUrl, secret, getActiveOrm };
      };

      api.addCommand(
        makeCurlCommand({
          getRegistry: () => new Registry(defaultRegistryPath()),
          getAuthAdapter: (): AuthAdapter => betterAuthAdapter,
          getAuthCtx: buildAuthCtx,
        }),
      );
    },
  };
}
