/**
 * Type-level tests for `defineConfig()` (LEV-180).
 *
 * These tests run under vitest so they execute alongside the runtime suite,
 * but the real assertions happen at compile time:
 *
 *  - `expectTypeOf` assertions verify the inferred unions for
 *    `NamedSourceKeys` / `BulkSourceIds` / `EnvInjectionConfig` match what we
 *    expect from a plugin tuple.
 *  - `@ts-expect-error` comments anchor "this MUST fail to compile" cases —
 *    typos in named source keys, non-bulk namespaces in `importAll`, etc.
 *    `tsc --noEmit` rejects the file if any of these comments doesn't actually
 *    sit above a type error (which is exactly what we want).
 *
 * No runtime expectations beyond "the file loads", since the actual asserts
 * are compile-time only.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { defineConfig } from '../src/define-config';
import type {
  NamedSourceKeys,
  BulkSourceIds,
  EnvInjectionConfig,
} from '../src/define-config';
import type { Plugin } from '../src/plugins/types';

// ----- Plugin fixtures used across the type assertions ------------------------
//
// Each fixture pins both the namespace (NS) and source manifest (S) generics
// so the inference rules can be exercised in isolation.

type PostgresPlugin = Plugin<'postgres', { named: 'url' | 'host'; bulk: false }>;
type RedisPlugin = Plugin<'redis', { named: 'url' }>;
type InfisicalPlugin = Plugin<'infisical', { bulk: true }>;
type DotenvPlugin = Plugin<'dotenv', { named: 'NODE_ENV'; bulk: true }>;
type StripePlugin = Plugin<'stripe', { named: 'api_key' | 'webhook_secret' }>;

const postgres: PostgresPlugin = {
  name: '@levelzero/plugin-postgres',
  version: '1.0.0',
  namespace: 'postgres',
  register() {},
};
const redis: RedisPlugin = {
  name: '@levelzero/plugin-redis',
  version: '1.0.0',
  namespace: 'redis',
  register() {},
};
const infisical: InfisicalPlugin = {
  name: '@levelzero/plugin-infisical',
  version: '1.0.0',
  namespace: 'infisical',
  register() {},
};
const dotenv: DotenvPlugin = {
  name: '@levelzero/plugin-dotenv',
  version: '1.0.0',
  namespace: 'dotenv',
  register() {},
};
const stripe: StripePlugin = {
  name: '@levelzero/plugin-stripe',
  version: '1.0.0',
  namespace: 'stripe',
  register() {},
};

describe('NamedSourceKeys — inference', () => {
  it('composes namespace + named into qualified keys', () => {
    type Keys = NamedSourceKeys<[PostgresPlugin]>;
    expectTypeOf<Keys>().toEqualTypeOf<'postgres.url' | 'postgres.host'>();
  });

  it('drops plugins without a named manifest', () => {
    type Keys = NamedSourceKeys<[InfisicalPlugin]>;
    expectTypeOf<Keys>().toEqualTypeOf<never>();
  });

  it('unions named keys across a mixed plugin tuple', () => {
    type Keys = NamedSourceKeys<[PostgresPlugin, RedisPlugin, StripePlugin]>;
    expectTypeOf<Keys>().toEqualTypeOf<
      | 'postgres.url'
      | 'postgres.host'
      | 'redis.url'
      | 'stripe.api_key'
      | 'stripe.webhook_secret'
    >();
  });
});

describe('BulkSourceIds — inference', () => {
  it('extracts only namespaces of plugins with bulk: true', () => {
    type Ids = BulkSourceIds<[PostgresPlugin, InfisicalPlugin]>;
    expectTypeOf<Ids>().toEqualTypeOf<'infisical'>();
  });

  it('returns never when no plugin declares bulk', () => {
    type Ids = BulkSourceIds<[PostgresPlugin, RedisPlugin]>;
    expectTypeOf<Ids>().toEqualTypeOf<never>();
  });

  it('unions namespaces when multiple plugins declare bulk', () => {
    type Ids = BulkSourceIds<[InfisicalPlugin, DotenvPlugin]>;
    expectTypeOf<Ids>().toEqualTypeOf<'infisical' | 'dotenv'>();
  });
});

describe('defineConfig — envInjection autocomplete and typo errors', () => {
  it('accepts a valid named source key', () => {
    defineConfig({
      plugins: [postgres] as const,
      envInjection: {
        DATABASE_URL: 'postgres.url',
      },
    });
  });

  it('exposes only valid named keys in the typed union (drives autocomplete)', () => {
    // The named-source slice of `EnvInjectionEntry` is the strict union of
    // qualified keys inferred from the plugin tuple. IDE autocomplete reads off
    // this union, so a typo like `'postgres.poort'` does not appear as a
    // suggestion.
    //
    // (The full `EnvInjectionEntry` also admits `string & {}` as an escape
    // hatch for bulk-source-derived keys — see the "escape-hatch" describe
    // block below. That branch is what keeps typos from being hard compile
    // errors, by design. Without the escape hatch, callers would need a cast
    // every time they wired in a runtime-known bulk key.)
    type Keys = NamedSourceKeys<[PostgresPlugin]>;
    expectTypeOf<Keys>().toEqualTypeOf<'postgres.url' | 'postgres.host'>();
  });

  it('does not include source keys from plugins outside the tuple', () => {
    // `redis.url` is not in the inferred named-key union when redis isn't in
    // `plugins`. Autocomplete won't suggest it; the `string & {}` escape hatch
    // still permits it as a runtime value, but it's clearly off-menu.
    type Keys = NamedSourceKeys<[PostgresPlugin]>;
    expectTypeOf<Keys>().not.toMatchTypeOf<'redis.url'>();
  });

  it('accepts importAll with bulk-source namespaces', () => {
    defineConfig({
      plugins: [postgres, infisical] as const,
      envInjection: {
        DATABASE_URL: 'postgres.url',
        importAll: ['infisical'],
      },
    });
  });

  it('errors when importAll lists a non-bulk namespace', () => {
    defineConfig({
      plugins: [postgres, infisical] as const,
      envInjection: {
        // @ts-expect-error 'postgres' does not declare bulk: true
        importAll: ['postgres'],
      },
    });
  });

  it('errors when importAll lists a namespace not in the tuple', () => {
    defineConfig({
      plugins: [infisical] as const,
      envInjection: {
        // @ts-expect-error 'dotenv' is not present in the plugin tuple
        importAll: ['dotenv'],
      },
    });
  });

  it('handles a mixed tuple (named-only, bulk-only, both) correctly', () => {
    defineConfig({
      plugins: [postgres, infisical, dotenv] as const,
      envInjection: {
        DATABASE_URL: 'postgres.url',
        POSTGRES_HOST: 'postgres.host',
        APP_NODE_ENV: 'dotenv.NODE_ENV',
        importAll: ['infisical', 'dotenv'],
      },
    });
  });

  it('errors when a named-only plugin is used in importAll on a mixed tuple', () => {
    defineConfig({
      plugins: [postgres, infisical, dotenv] as const,
      envInjection: {
        // @ts-expect-error 'postgres' is named-only, not bulk
        importAll: ['postgres', 'infisical'],
      },
    });
  });
});

describe('defineConfig — escape-hatch for runtime-known bulk keys', () => {
  it('accepts a plain string value (typed as string & {})', () => {
    // Bulk-source-derived env var names are not visible at the type level — the
    // `string & {}` branch of EnvInjectionEntry is the escape hatch that lets
    // consumers map an arbitrary env var to a string without a cast.
    const runtimeKey: string = 'infisical.STRIPE_SECRET';
    defineConfig({
      plugins: [postgres, infisical] as const,
      envInjection: {
        DATABASE_URL: 'postgres.url',
        STRIPE_SECRET: runtimeKey,
      },
    });
  });
});

describe('EnvInjectionConfig — shape', () => {
  it('importAll is optional', () => {
    type Cfg = EnvInjectionConfig<[PostgresPlugin]>;
    // The `importAll?: …` declaration means accessing it gives the array type
    // OR undefined.
    expectTypeOf<Cfg['importAll']>().toEqualTypeOf<never[] | undefined>();
  });
});

describe('defineConfig — untyped fallback compatibility', () => {
  it('still works with an empty plugin tuple', () => {
    const cfg = defineConfig({
      plugins: [] as const,
      envInjection: {
        // No plugins => no typed keys, but the string & {} escape hatch admits
        // any string. This preserves the "untyped users can still set
        // envInjection" promise.
        SOME_VAR: 'whatever.you.want',
      },
    });
    expectTypeOf(cfg.plugins).toEqualTypeOf<readonly []>();
  });
});
