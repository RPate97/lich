import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterSlot,
  BulkEnvSource,
  Command,
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
  EnvSource,
  EnvSourceContext,
  PluginAPI,
  PluginContext,
} from '@levelzero/core';
import infisical from '../src/index';
import type {
  InfisicalAuthInputs,
  InfisicalClient,
  InfisicalClientFactory,
  InfisicalSecret,
} from '../src/client';

/**
 * Recording `PluginAPI` for the infisical plugin. Mirrors the shape used
 * by `plugin-dotenv`'s tests — every surface the plugin could touch is
 * captured so the "registers exactly one bulk source" invariant can be
 * asserted alongside the resolver behavior.
 */
function makeRecordingApi(): {
  api: PluginAPI<'infisical'>;
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
  envSources: Record<string, EnvSource>;
  bulk: BulkEnvSource[];
  adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }>;
  actives: Array<{ slot: AdapterSlot; name: string }>;
  commands: Command[];
} {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const envSources: Record<string, EnvSource> = {};
  const bulk: BulkEnvSource[] = [];
  const adapters: Array<{ slot: AdapterSlot; name: string; impl: unknown }> = [];
  const actives: Array<{ slot: AdapterSlot; name: string }> = [];
  const commands: Command[] = [];
  const api: PluginAPI<'infisical'> = {
    addAdapter: (slot, name, impl) => {
      adapters.push({ slot, name, impl });
    },
    setActiveAdapter: (slot, name) => {
      actives.push({ slot, name });
    },
    addCommand: (cmd) => {
      commands.push(cmd);
    },
    addOwnedService: vi.fn(),
    addComposeService: (name, def) => {
      services[name] = def;
    },
    addComposeVolume: (name, def) => {
      volumes[name] = def;
    },
    addComposeNetwork: (name, def) => {
      networks[name] = def;
    },
    addRule: vi.fn(),
    addGenerator: vi.fn(),
    addSkillsDir: vi.fn(),
    addEnvSource: (name, source) => {
      envSources[name] = source;
    },
    addBulkEnvSource: (source) => {
      bulk.push(source);
    },
  };
  return { api, services, volumes, networks, envSources, bulk, adapters, actives, commands };
}

/**
 * `EnvSourceContext` with sane defaults; the resolver only reads
 * `process.env` (not the context) but we pass a realistic value so any
 * accidental coupling shows up as a test failure rather than a silent dep.
 */
function makeCtx(overrides: Partial<EnvSourceContext> = {}): EnvSourceContext {
  return {
    ports: {},
    projectRoot: '/tmp/example',
    worktreeKey: 'abc12345',
    consumerContext: 'host',
    ...overrides,
  };
}

/**
 * Build a fake `InfisicalClient` + a `clientFactory` that records every
 * auth call. Tests pass the factory via `_clientFactory` so they don't
 * need to mock the module-level `createClient` export. Returning both the
 * factory AND its observations as one object keeps each test's setup to
 * two lines.
 */
function makeFakeClient(opts: {
  secrets?: InfisicalSecret[];
  listSecretsError?: Error;
  authError?: Error;
} = {}): {
  factory: InfisicalClientFactory;
  authCalls: InfisicalAuthInputs[];
  listSecretsCalls: Array<{ projectId: string; environment: string; secretPath: string }>;
} {
  const authCalls: InfisicalAuthInputs[] = [];
  const listSecretsCalls: Array<{
    projectId: string;
    environment: string;
    secretPath: string;
  }> = [];
  const client: InfisicalClient = {
    listSecrets: async (input) => {
      listSecretsCalls.push(input);
      if (opts.listSecretsError) throw opts.listSecretsError;
      return opts.secrets ?? [];
    },
  };
  const factory: InfisicalClientFactory = async (inputs) => {
    authCalls.push(inputs);
    if (opts.authError) throw opts.authError;
    return client;
  };
  return { factory, authCalls, listSecretsCalls };
}

/**
 * Drive the plugin to register, then return the single registered bulk source.
 * Mirrors the dotenv test helper; throws loud if registration didn't produce
 * exactly one bulk source.
 */
async function bootAndGetBulk(plugin: ReturnType<typeof infisical>): Promise<BulkEnvSource> {
  const { api, bulk } = makeRecordingApi();
  const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
  await plugin.register(api, ctx);
  expect(bulk).toHaveLength(1);
  return bulk[0]!;
}

/**
 * process.env snapshot/restore — the universal-auth tests mutate
 * `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`, and we don't want
 * those leaking across cases or out of the test process.
 */
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv };
});
afterEach(() => {
  process.env = originalEnv;
});

describe('@levelzero/plugin-infisical factory (LEV-189)', () => {
  it('produces a Plugin with the canonical name + namespace + version', () => {
    const plugin = infisical({ project: 'p', environment: 'dev' });
    expect(plugin.name).toBe('@levelzero/plugin-infisical');
    expect(plugin.namespace).toBe('infisical');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.register).toBe('function');
  });

  it('honors an explicit namespace override', () => {
    const plugin = infisical({
      project: 'p',
      environment: 'dev',
      namespace: 'secrets',
    });
    expect(plugin.namespace).toBe('secrets');
  });

  it('registers exactly one bulk source and no named sources', async () => {
    const { api, services, envSources, bulk, volumes, networks } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await infisical({ project: 'p', environment: 'dev' }).register(api, ctx);

    expect(bulk).toHaveLength(1);
    expect(Object.keys(envSources)).toEqual([]);
    expect(Object.keys(services)).toEqual([]);
    expect(Object.keys(volumes)).toEqual([]);
    expect(Object.keys(networks)).toEqual([]);
  });

  it('does not contribute adapters, commands, owned/compose services, etc.', async () => {
    const { api, adapters, actives, commands } = makeRecordingApi();
    const ctx: PluginContext = { projectRoot: '/tmp/example', config: {} };
    await infisical({ project: 'p', environment: 'dev' }).register(api, ctx);

    expect(adapters).toEqual([]);
    expect(actives).toEqual([]);
    expect(commands).toEqual([]);
  });
});

describe('@levelzero/plugin-infisical token auth', () => {
  it('uses opts.token when set, skipping the env-var path entirely', async () => {
    // Salt process.env with universal-auth vars to prove they're ignored
    // when an explicit token is present.
    process.env.INFISICAL_CLIENT_ID = 'should-not-be-used';
    process.env.INFISICAL_CLIENT_SECRET = 'should-not-be-used';

    const fake = makeFakeClient({
      secrets: [
        { secretKey: 'API_KEY', secretValue: 'abc123' },
        { secretKey: 'DB_URL', secretValue: 'postgres://x' },
      ],
    });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'proj-1',
        environment: 'dev',
        token: 'tok-xyz',
        _clientFactory: fake.factory,
      }),
    );
    const out = await bulk.resolve(makeCtx());

    // Exactly one auth call, in token mode, with no client_id/secret leak.
    expect(fake.authCalls).toHaveLength(1);
    expect(fake.authCalls[0]).toEqual({ token: 'tok-xyz', apiUrl: undefined });
    expect(out).toEqual({ API_KEY: 'abc123', DB_URL: 'postgres://x' });
  });

  it('passes a custom apiUrl through to the client factory', async () => {
    const fake = makeFakeClient({ secrets: [] });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'p',
        environment: 'dev',
        token: 'tok',
        apiUrl: 'https://infisical.internal.example.com',
        _clientFactory: fake.factory,
      }),
    );
    await bulk.resolve(makeCtx());

    // Load-bearing for self-hosted users: a missed apiUrl pass-through
    // would silently point them at Infisical Cloud.
    expect(fake.authCalls[0]?.apiUrl).toBe('https://infisical.internal.example.com');
  });
});

describe('@levelzero/plugin-infisical universal-auth (machine identity)', () => {
  it('reads INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET from process.env by default', async () => {
    process.env.INFISICAL_CLIENT_ID = 'ci-id';
    process.env.INFISICAL_CLIENT_SECRET = 'ci-sec';

    const fake = makeFakeClient({
      secrets: [{ secretKey: 'STRIPE_KEY', secretValue: 'sk_test_x' }],
    });
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', _clientFactory: fake.factory }),
    );
    const out = await bulk.resolve(makeCtx());

    expect(fake.authCalls).toHaveLength(1);
    expect(fake.authCalls[0]).toEqual({
      clientId: 'ci-id',
      clientSecret: 'ci-sec',
      apiUrl: undefined,
    });
    expect(out).toEqual({ STRIPE_KEY: 'sk_test_x' });
  });

  it('honors configurable clientIdFromEnv + clientSecretFromEnv', async () => {
    // Default vars unset — only the custom names should be consulted.
    process.env.MYAPP_INFISICAL_CLIENT_ID = 'custom-id';
    process.env.MYAPP_INFISICAL_CLIENT_SECRET = 'custom-sec';

    const fake = makeFakeClient({ secrets: [] });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'p',
        environment: 'dev',
        clientIdFromEnv: 'MYAPP_INFISICAL_CLIENT_ID',
        clientSecretFromEnv: 'MYAPP_INFISICAL_CLIENT_SECRET',
        _clientFactory: fake.factory,
      }),
    );
    await bulk.resolve(makeCtx());

    expect(fake.authCalls[0]).toEqual({
      clientId: 'custom-id',
      clientSecret: 'custom-sec',
      apiUrl: undefined,
    });
  });
});

describe('@levelzero/plugin-infisical missing credentials', () => {
  it('throws a clear boot-time error when nothing is set', async () => {
    // Make sure no defaults leak in from the host shell.
    delete process.env.INFISICAL_CLIENT_ID;
    delete process.env.INFISICAL_CLIENT_SECRET;

    const fake = makeFakeClient();
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', _clientFactory: fake.factory }),
    );

    // Use `.rejects.toThrowError` with a regex so the message can evolve
    // without rewriting the test — but pin the load-bearing pieces:
    // plugin name + both env var names + hint about plugin-dotenv.
    await expect(bulk.resolve(makeCtx())).rejects.toThrowError(
      /@levelzero\/plugin-infisical.*missing credentials.*INFISICAL_CLIENT_ID.*INFISICAL_CLIENT_SECRET.*plugin-dotenv/s,
    );
    // The factory must not be called when validation fails — otherwise we
    // would have hit the SDK with empty creds and gotten a less helpful
    // error message.
    expect(fake.authCalls).toHaveLength(0);
  });

  it('only one of clientId / clientSecret set still counts as missing', async () => {
    // Half-configured machine identity is a common foot-gun (only one
    // exported in CI). Make sure we treat it as missing rather than
    // silently passing an empty string.
    process.env.INFISICAL_CLIENT_ID = 'id-only';
    delete process.env.INFISICAL_CLIENT_SECRET;

    const fake = makeFakeClient();
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', _clientFactory: fake.factory }),
    );
    await expect(bulk.resolve(makeCtx())).rejects.toThrowError(/missing credentials/);
    expect(fake.authCalls).toHaveLength(0);
  });

  it('mentions the custom env var names when configured', async () => {
    // When the user picks custom var names, the error message should
    // name the ones they actually need to set — pointing at
    // `INFISICAL_CLIENT_ID` would send them looking in the wrong place.
    delete process.env.MYAPP_ID;
    delete process.env.MYAPP_SECRET;

    const fake = makeFakeClient();
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'p',
        environment: 'dev',
        clientIdFromEnv: 'MYAPP_ID',
        clientSecretFromEnv: 'MYAPP_SECRET',
        _clientFactory: fake.factory,
      }),
    );
    await expect(bulk.resolve(makeCtx())).rejects.toThrowError(/MYAPP_ID.*MYAPP_SECRET/);
  });
});

describe('@levelzero/plugin-infisical SDK error wrapping', () => {
  it('wraps auth failures with the plugin attribution', async () => {
    const fake = makeFakeClient({ authError: new Error('401 unauthorized') });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'p',
        environment: 'dev',
        token: 'bad-token',
        _clientFactory: fake.factory,
      }),
    );

    await expect(bulk.resolve(makeCtx())).rejects.toThrowError(
      /@levelzero\/plugin-infisical: authentication failed.*401 unauthorized/,
    );
  });

  it('wraps listSecrets failures with project + environment + folder context', async () => {
    const fake = makeFakeClient({
      listSecretsError: new Error('project not found'),
    });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'proj-missing',
        environment: 'staging',
        folder: '/api',
        token: 'tok',
        _clientFactory: fake.factory,
      }),
    );

    // Load-bearing: the wrapped error should name the exact triple that
    // failed so a user staring at the message in CI logs can immediately
    // tell whether the project ID, environment slug, or folder path is
    // the typo.
    await expect(bulk.resolve(makeCtx())).rejects.toThrowError(
      /@levelzero\/plugin-infisical: listSecrets failed.*proj-missing.*staging.*\/api.*project not found/,
    );
  });

  it('preserves the original error as `cause` for debuggers', async () => {
    const original = new Error('network down');
    const fake = makeFakeClient({ listSecretsError: original });
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', token: 'tok', _clientFactory: fake.factory }),
    );

    try {
      await bulk.resolve(makeCtx());
      // If we got here the test setup is broken — listSecretsError
      // should have thrown.
      throw new Error('expected resolve() to throw');
    } catch (err) {
      // `cause` is the standard ES2022 escape hatch for "underlying
      // error". Logging frameworks and IDE debuggers walk the chain so
      // preserving it is what lets users see the SDK's stack trace
      // beneath ours.
      expect((err as Error).cause).toBe(original);
    }
  });
});

describe('@levelzero/plugin-infisical secret-fetch arguments', () => {
  it('passes project + environment + folder through to listSecrets', async () => {
    const fake = makeFakeClient({ secrets: [] });
    const bulk = await bootAndGetBulk(
      infisical({
        project: 'proj-abc',
        environment: 'prod',
        folder: '/backend/api',
        token: 'tok',
        _clientFactory: fake.factory,
      }),
    );
    await bulk.resolve(makeCtx());

    expect(fake.listSecretsCalls).toHaveLength(1);
    expect(fake.listSecretsCalls[0]).toEqual({
      projectId: 'proj-abc',
      environment: 'prod',
      secretPath: '/backend/api',
    });
  });

  it("defaults folder to '/' when not provided", async () => {
    const fake = makeFakeClient({ secrets: [] });
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', token: 'tok', _clientFactory: fake.factory }),
    );
    await bulk.resolve(makeCtx());

    // The SDK accepts `secretPath` as optional with its own '/' default,
    // but we pass it explicitly so the plugin's behavior is independent
    // of SDK version drift.
    expect(fake.listSecretsCalls[0]?.secretPath).toBe('/');
  });

  it('returns `{}` for an empty secret list without throwing', async () => {
    const fake = makeFakeClient({ secrets: [] });
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', token: 'tok', _clientFactory: fake.factory }),
    );
    const out = await bulk.resolve(makeCtx());
    // A project with no secrets in a folder is a legitimate state (just-
    // initialised, all secrets in a sibling folder, …). Throwing here
    // would block boot for a non-error condition.
    expect(out).toEqual({});
  });

  it('skips secrets whose value is null/undefined', async () => {
    // The SDK marks a value as null when the caller's identity can see
    // the key but not the value (permission boundary). Emitting an
    // empty string would silently inject a wrong value into downstream
    // services; skipping is the safer default.
    const fake = makeFakeClient({
      secrets: [
        { secretKey: 'OK', secretValue: 'visible' },
        // Type-cast to satisfy the strict `InfisicalSecret` interface —
        // at runtime the SDK really does emit non-string values for
        // permission-shielded secrets.
        { secretKey: 'HIDDEN', secretValue: null as unknown as string },
      ],
    });
    const bulk = await bootAndGetBulk(
      infisical({ project: 'p', environment: 'dev', token: 'tok', _clientFactory: fake.factory }),
    );
    const out = await bulk.resolve(makeCtx());
    expect(out).toEqual({ OK: 'visible' });
    expect(out.HIDDEN).toBeUndefined();
  });
});

describe('@levelzero/plugin-infisical namespace override', () => {
  it('still registers exactly one bulk source under the overridden namespace', async () => {
    const fake = makeFakeClient({ secrets: [{ secretKey: 'X', secretValue: 'y' }] });
    const plugin = infisical({
      project: 'p',
      environment: 'dev',
      token: 'tok',
      namespace: 'secrets',
      _clientFactory: fake.factory,
    });
    expect(plugin.namespace).toBe('secrets');

    const bulk = await bootAndGetBulk(plugin);
    const out = await bulk.resolve(makeCtx());
    expect(out).toEqual({ X: 'y' });
  });
});
