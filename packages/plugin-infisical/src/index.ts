import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import {
  createClient as defaultCreateClient,
  type InfisicalClient,
  type InfisicalClientFactory,
} from './client';

/**
 * Options accepted by the `@levelzero/plugin-infisical` factory.
 *
 *  - `project`               — Infisical project ID. Required. The plugin
 *                              passes this through to the SDK as `projectId`
 *                              for `listSecrets`.
 *  - `environment`           — Environment slug (`'dev'`, `'staging'`,
 *                              `'prod'`, …). Required.
 *  - `folder`                — Folder path inside the project. Default `/`,
 *                              meaning "the root folder". Most projects keep
 *                              all dev secrets at `/` and use environment
 *                              slugs to split scopes.
 *  - `token`                 — Raw Infisical service token (older auth
 *                              method, still supported). When set, the plugin
 *                              skips the universal-auth flow entirely and
 *                              uses the SDK's `accessToken(...)` shortcut.
 *  - `clientIdFromEnv`       — Name of the env var to read the
 *                              machine-identity `client_id` from. Default
 *                              `INFISICAL_CLIENT_ID`. Configurable for
 *                              projects that prefix env vars (e.g.
 *                              `MYAPP_INFISICAL_CLIENT_ID`).
 *  - `clientSecretFromEnv`   — Name of the env var to read the
 *                              machine-identity `client_secret` from.
 *                              Default `INFISICAL_CLIENT_SECRET`.
 *  - `apiUrl`                — Self-hosted Infisical URL. Defaults to
 *                              `https://app.infisical.com` (Infisical Cloud).
 *  - `namespace`             — Override the default `infisical` namespace
 *                              if a project loads two Infisical plugins
 *                              side-by-side (e.g. one for shared secrets,
 *                              one for per-service secrets).
 *  - `_clientFactory`        — **Internal escape hatch for tests.** Injects
 *                              a fake `InfisicalClient` factory so the
 *                              plugin can be exercised without touching the
 *                              real SDK or making network calls. Underscore
 *                              prefix flags it as "do not use in production
 *                              configs"; the runtime never relies on it.
 */
export interface InfisicalOptions {
  project: string;
  environment: string;
  folder?: string;
  token?: string;
  clientIdFromEnv?: string;
  clientSecretFromEnv?: string;
  apiUrl?: string;
  namespace?: string;
  /** @internal */
  _clientFactory?: InfisicalClientFactory;
}

/**
 * Error message helper. Centralised so the boot-time + resolve-time errors
 * speak with one voice and so the test suite has a single string to assert
 * against without coupling to internal implementation details. Anything user-
 * actionable goes through here so users can grep for the plugin name when
 * something breaks.
 */
function wrapError(detail: string, cause?: unknown): Error {
  const message = `@levelzero/plugin-infisical: ${detail}`;
  // `cause` propagates the original error chain when supported, so
  // `console.error(err)` shows the SDK's failure underneath ours.
  if (cause !== undefined) {
    return new Error(message, { cause });
  }
  return new Error(message);
}

/**
 * `@levelzero/plugin-infisical` (LEV-189).
 *
 * Fetches secrets from an Infisical project + environment + folder at boot
 * and publishes them as a single **bulk EnvSource** under the `infisical`
 * namespace. The shape is identical to `@levelzero/plugin-dotenv`'s bulk
 * source — the framework treats both interchangeably from the consumer's
 * point of view; `envInjection: { importAll: ['infisical'] }` is enough to
 * pull every fetched secret into the generated `.env.<service>` files.
 *
 * ## Authentication
 *
 * Two modes, picked at boot in priority order:
 *
 *  1. **Service token** — pass `opts.token` directly. The SDK calls
 *     `auth().accessToken(token)` and we're done. Best for CI environments
 *     that already inject a token via secrets-manager bindings.
 *
 *  2. **Machine identity (universal auth)** — read `client_id` +
 *     `client_secret` from `process.env`. The plugin invokes
 *     `auth().universalAuth.login({ clientId, clientSecret })` to exchange
 *     them for a short-lived access token. This is the recommended path
 *     for developer machines: pair with `@levelzero/plugin-dotenv` and
 *     keep the credentials in `.env.local` (gitignored).
 *
 * If neither mode resolves to a complete credential set, the bulk resolver
 * throws at boot with a message pointing the user at `INFISICAL_CLIENT_ID`
 * / `INFISICAL_CLIENT_SECRET` and the dotenv plugin. We deliberately do NOT
 * throw at factory-call time — the env vars might be populated later in
 * the boot sequence by another plugin (specifically `@levelzero/plugin-
 * dotenv`, which the docs recommend running first).
 *
 * ## Worktree safety
 *
 * Bulk resolvers receive `ctx.projectRoot` (parent repo), never the
 * worktree checkout. The Infisical plugin reads credentials from
 * `process.env`, which the dotenv plugin populates from
 * `.env.local` at the workspace root — identical worktree-safety story to
 * every other secret-loader plugin in this monorepo.
 *
 * ## Refresh
 *
 * Secrets are fetched ONCE per boot. Long-running `levelzero dev` sessions
 * will not pick up upstream changes without a restart. This is documented
 * in the plan as out-of-scope for v0; a future ticket may add a TTL-based
 * re-resolve.
 *
 * ## Wire it into a project
 *
 * ```ts
 * import dotenv from '@levelzero/plugin-dotenv';
 * import infisical from '@levelzero/plugin-infisical';
 *
 * export default defineConfig({
 *   // Order matters: dotenv populates process.env so infisical can read
 *   // its machine-identity credentials at boot.
 *   plugins: [
 *     dotenv(),
 *     infisical({ project: 'proj-abc123', environment: 'dev' }),
 *   ],
 *   envInjection: {
 *     importAll: ['dotenv', 'infisical'],
 *   },
 * });
 * ```
 */
export default function infisical(opts: InfisicalOptions): Plugin<
  'infisical',
  {
    named: never;
    bulk: true;
  }
> {
  // Capture inputs once so the resolver closure doesn't re-default on every
  // boot cycle. The `_clientFactory` escape hatch defaults to the real SDK
  // wrapper from `./client`; tests override it with a fake.
  const project = opts.project;
  const environment = opts.environment;
  const folder = opts.folder ?? '/';
  const explicitToken = opts.token;
  const clientIdVar = opts.clientIdFromEnv ?? 'INFISICAL_CLIENT_ID';
  const clientSecretVar = opts.clientSecretFromEnv ?? 'INFISICAL_CLIENT_SECRET';
  const apiUrl = opts.apiUrl;
  const clientFactory = opts._clientFactory ?? defaultCreateClient;

  return {
    name: '@levelzero/plugin-infisical',
    namespace: (opts.namespace ?? 'infisical') as 'infisical',
    version: '0.1.0',

    register(api: PluginAPI<'infisical'>, _ctx: PluginContext): void {
      api.addBulkEnvSource({
        resolve: async () => {
          // Re-read process.env on each resolve — the dotenv plugin's
          // bulk resolver runs in parallel with ours during boot, but the
          // framework guarantees process.env is populated before any
          // resolver runs (env-source registration happens during plugin
          // `register()`, but resolution happens after the whole plugin
          // graph is built). Reading at resolve-time means a missing
          // credential is surfaced at the exact moment the value is
          // needed, with the freshest possible view of process.env.
          const envClientId = process.env[clientIdVar];
          const envClientSecret = process.env[clientSecretVar];

          let client: InfisicalClient;
          try {
            if (explicitToken) {
              // Service-token / raw access-token mode.
              client = await clientFactory({ token: explicitToken, apiUrl });
            } else if (envClientId && envClientSecret) {
              // Universal-auth (machine identity) mode.
              client = await clientFactory({
                clientId: envClientId,
                clientSecret: envClientSecret,
                apiUrl,
              });
            } else {
              // Neither mode usable — fail loud with a message that names
              // every env var the user can check, and points at the
              // companion plugin that's almost certainly the right place
              // to put them.
              throw wrapError(
                `missing credentials. Set either \`token\` in the plugin options ` +
                  `OR populate \`${clientIdVar}\` + \`${clientSecretVar}\` in process.env ` +
                  `(typically via \`@levelzero/plugin-dotenv\` reading \`.env.local\`).`,
              );
            }
          } catch (err) {
            // Re-throw "missing credentials" errors verbatim — they're
            // already our own and carry the actionable message.
            if (err instanceof Error && err.message.startsWith('@levelzero/plugin-infisical:')) {
              throw err;
            }
            // Anything else came from the SDK (network failure, bad
            // creds, project not found, …). Wrap with our attribution so
            // grep'ing logs for the plugin name finds it.
            throw wrapError(`authentication failed: ${(err as Error)?.message ?? String(err)}`, err);
          }

          let secrets;
          try {
            secrets = await client.listSecrets({
              projectId: project,
              environment,
              secretPath: folder,
            });
          } catch (err) {
            throw wrapError(
              `listSecrets failed for project=${project} environment=${environment} folder=${folder}: ` +
                `${(err as Error)?.message ?? String(err)}`,
              err,
            );
          }

          // Reduce to `Record<string, string>`. The SDK returns `null` /
          // `undefined` for `secretValue` only when the caller's identity
          // lacks read permission on a specific secret — in that case we
          // skip the key rather than emit an empty string (which would
          // silently mask a permission issue downstream). When the entire
          // list is empty, we just return `{}` — a project with no
          // secrets in the configured folder is a legitimate state, not
          // an error.
          const out: Record<string, string> = {};
          for (const s of secrets) {
            if (typeof s.secretValue === 'string') {
              out[s.secretKey] = s.secretValue;
            }
          }
          return out;
        },
      });
    },
  };
}
