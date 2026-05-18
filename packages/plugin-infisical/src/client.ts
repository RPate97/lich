/**
 * Thin wrapper around `@infisical/sdk` that hides the concrete SDK class
 * behind a small interface, so the plugin's resolver can be exercised in
 * tests with a fully synchronous fake — no network mocking, no SDK install
 * at test time, no version coupling.
 *
 * The exported `createClient` is the single touch-point that imports the
 * real SDK; tests inject their own via the `_clientFactory` escape hatch
 * on `InfisicalOptions` (preferred — no `vi.mock` global state), or by
 * spying on this module as a fallback.
 */

/**
 * Inputs the plugin passes to `createClient`. Mirrors the two auth modes
 * the SDK supports today: pass a raw `token` (service-token mode) OR a
 * `clientId` + `clientSecret` pair (machine-identity universal-auth flow).
 * Exactly one combination should be set — the plugin validates that before
 * calling us.
 */
export interface InfisicalAuthInputs {
  /** Raw service token (older auth method — keeps working). */
  token?: string;
  /** Machine-identity client_id for the universal-auth login flow. */
  clientId?: string;
  /** Machine-identity client_secret for the universal-auth login flow. */
  clientSecret?: string;
  /** Optional API URL override (defaults to `https://app.infisical.com`). */
  apiUrl?: string;
}

/**
 * Options for the one call we make against the SDK once the client is
 * authenticated. Kept separate from `InfisicalAuthInputs` so the plugin can
 * authenticate once at boot and then call `listSecrets` per resolve cycle if
 * we ever add refresh — today it's still one shot.
 */
export interface ListSecretsInputs {
  /** Infisical project ID (UUID-ish). */
  projectId: string;
  /** Environment slug (`dev`, `staging`, `prod`, …). */
  environment: string;
  /** Folder path inside the project. Defaults to `/` upstream. */
  secretPath: string;
}

/**
 * Minimal subset of `ApiV3SecretsRawGet200ResponseSecretsInner` the resolver
 * cares about. Reproducing the shape here (instead of re-exporting the SDK
 * type) keeps the package's surface narrow and lets the fake client in
 * tests be a plain `{ secretKey, secretValue }` literal.
 */
export interface InfisicalSecret {
  secretKey: string;
  secretValue: string;
}

/**
 * Shape of the authenticated client the plugin actually uses. Matches the
 * intersection of `@infisical/sdk@^3` methods we need — nothing more. Tests
 * implement this with a couple of vi.fn()s and never touch the real SDK.
 */
export interface InfisicalClient {
  listSecrets: (input: ListSecretsInputs) => Promise<InfisicalSecret[]>;
}

/**
 * Factory signature for `createClient`. Exported so `InfisicalOptions._clientFactory`
 * has a precise type and so tests can write a fake with full IDE autocomplete.
 */
export type InfisicalClientFactory = (
  inputs: InfisicalAuthInputs,
) => Promise<InfisicalClient>;

/**
 * Lazily load the SDK module so importing this file doesn't trigger
 * `@infisical/sdk` resolution in environments that never plan to use it
 * (and so tests that fully replace the factory don't drag in the SDK).
 *
 * The function is async because the universal-auth login flow is async,
 * AND because dynamic-importing the SDK lets unrelated callers (e.g. the
 * `plugin-infisical` package's own test suite, which never calls
 * `createClient`) avoid the SDK's `axios` + `zod` dependency footprint.
 */
export const createClient: InfisicalClientFactory = async (inputs) => {
  // Dynamic import: only pull the SDK in when this code path actually runs.
  // The `// @ts-ignore` is a deliberate concession to the fact that the
  // SDK isn't installed in the test environment (vitest never reaches this
  // line — the plugin's tests inject `_clientFactory`). Production
  // installs `@infisical/sdk` as a dependency so the import resolves
  // cleanly at runtime.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — peer-dep resolved at runtime
  const mod = await import('@infisical/sdk');
  const SDKCtor = mod.InfisicalSDK ?? mod.default?.InfisicalSDK ?? mod.default;
  if (typeof SDKCtor !== 'function') {
    throw new Error(
      '@levelzero/plugin-infisical: failed to load InfisicalSDK from @infisical/sdk — ' +
        'the installed SDK does not export the expected class. ' +
        'Pin `@infisical/sdk@^3.0.0` in your project dependencies.',
    );
  }

  // The SDK constructor only takes `siteUrl`; the credentials flow through
  // `auth().{accessToken,universalAuth.login}` below. Default URL matches
  // Infisical Cloud — self-hosted projects override via `opts.apiUrl`.
  const sdk = new SDKCtor({ siteUrl: inputs.apiUrl ?? 'https://app.infisical.com' });

  // Resolve auth mode. The plugin has already validated that exactly one
  // mode's inputs are present, but we re-check defensively to keep the
  // failure mode local rather than letting the SDK throw a less helpful
  // error from inside its own auth flow.
  let authed: unknown;
  if (inputs.token) {
    // Service-token / raw access-token mode — the SDK exposes this as
    // `auth().accessToken(token)`, which returns an authenticated SDK
    // instance ready to call `.secrets()` against.
    authed = sdk.auth().accessToken(inputs.token);
  } else if (inputs.clientId && inputs.clientSecret) {
    authed = await sdk
      .auth()
      .universalAuth.login({ clientId: inputs.clientId, clientSecret: inputs.clientSecret });
  } else {
    // Shouldn't happen — plugin validates first — but throw a clear error
    // if it ever does so debugging doesn't require reading the SDK source.
    throw new Error(
      '@levelzero/plugin-infisical: createClient called without credentials. ' +
        'Pass either `token` or `clientId` + `clientSecret`.',
    );
  }

  // After `accessToken()` or `universalAuth.login()` the SDK methods we
  // care about live on the returned instance. Cast to the shape we need so
  // downstream code is fully typed against our minimal `InfisicalClient`
  // contract rather than the SDK's much larger surface.
  const authedSdk = authed as {
    secrets: () => {
      listSecrets: (opts: {
        projectId: string;
        environment: string;
        secretPath?: string;
      }) => Promise<{ secrets: Array<{ secretKey: string; secretValue: string }> }>;
    };
  };

  return {
    listSecrets: async (input) => {
      const result = await authedSdk.secrets().listSecrets({
        projectId: input.projectId,
        environment: input.environment,
        secretPath: input.secretPath,
      });
      // Re-shape into the minimal `InfisicalSecret[]` the plugin expects.
      // The SDK returns the full inner-secret type which carries metadata
      // (id, version, createdAt, …) we never read — dropping it here keeps
      // the in-memory representation small and the test fakes simple.
      return result.secrets.map((s) => ({
        secretKey: s.secretKey,
        secretValue: s.secretValue,
      }));
    },
  };
};
