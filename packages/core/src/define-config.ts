/**
 * `defineConfig()` — authoring-time helper that flows plugin types through to
 * `envInjection` for autocomplete and typo errors (Plan 16 / LEV-180).
 *
 * The function is a runtime no-op: it returns its argument unchanged. Its only
 * purpose is to let TypeScript infer the union of legal source keys from the
 * `plugins` tuple so consumers get autocomplete on `envInjection` values and
 * compile errors on typos.
 *
 * Usage:
 * ```ts
 * import { defineConfig } from "@levelzero/core";
 * import postgres from "@levelzero/plugin-postgres";
 * import infisical from "@levelzero/plugin-infisical";
 *
 * export default defineConfig({
 *   plugins: [postgres(), infisical({ ... })],
 *   envInjection: {
 *     DATABASE_URL: 'postgres.url',  // autocompleted from plugin tuple
 *     importAll:    ['infisical'],   // only namespaces that declared bulk: true
 *   },
 * });
 * ```
 *
 * Consumers may continue to author untyped `export default { ... }` configs —
 * `defineConfig()` is opt-in. The runtime parser (`loadConfig`) only enforces
 * structural shape; source-key validation is LEV-181's job.
 */

import type { Plugin } from './plugins/types';
import type { LevelzeroConfig as BaseLevelzeroConfig } from './config';

/**
 * Union of fully-qualified named source keys (`${namespace}.${name}`) extracted
 * from a plugin tuple. Each plugin's `SourceManifest['named']` is combined with
 * its declared namespace `NS` to produce the legal string literals.
 *
 * Plugins whose manifest omits `named` contribute `never`, dropping out of the
 * union — only plugins that actually publish named sources show up in
 * autocomplete.
 */
export type NamedSourceKeys<P extends readonly Plugin<any, any>[]> = {
  [I in keyof P]: P[I] extends Plugin<infer NS, infer S>
    ? S extends { named: infer N extends string }
      ? `${NS}.${N}`
      : never
    : never;
}[number];

/**
 * Union of namespace string literals for plugins that declared `bulk: true` in
 * their `SourceManifest`. Used to constrain `envInjection.importAll` so it only
 * accepts namespaces of plugins that actually publish a bulk source.
 *
 * Plugins without a bulk source contribute `never` and drop out — keeping the
 * union tight so `importAll: ['postgres']` is a type error if postgres has no
 * bulk source.
 */
export type BulkSourceIds<P extends readonly Plugin<any, any>[]> = {
  [I in keyof P]: P[I] extends Plugin<infer NS, infer S>
    ? S extends { bulk: true }
      ? NS
      : never
    : never;
}[number];

/**
 * Value position in `envInjection`. Either a typed `namespace.name` literal
 * inferred from the plugin tuple, or `string & {}` as an escape hatch for
 * runtime-known bulk-source keys (whose names aren't visible to the type
 * system).
 *
 * The `string & {}` branch keeps autocomplete working for the literal union
 * while still allowing plain strings to be passed without a cast.
 */
export type EnvInjectionEntry<P extends readonly Plugin<any, any>[]> =
  | NamedSourceKeys<P>
  | (string & {});

/**
 * Shape of the `envInjection` block when authored through `defineConfig()`.
 *
 *  - Arbitrary `ENV_VAR_NAME` keys map to a typed named source key (or an
 *    opaque string for bulk-source-derived names).
 *  - `importAll` declares which bulk-source namespaces to pull through
 *    wholesale; values are constrained to namespaces of plugins that declared
 *    `bulk: true`.
 */
export interface EnvInjectionConfig<P extends readonly Plugin<any, any>[]> {
  [envVar: string]: EnvInjectionEntry<P> | BulkSourceIds<P>[] | undefined;
  importAll?: BulkSourceIds<P>[];
}

/**
 * Generic variant of `LevelzeroConfig` that carries the `plugins` tuple type
 * through to `envInjection`. The base type's `plugins` and `envInjection`
 * fields are replaced with parameterized versions; everything else (name,
 * adapters, …) is inherited untouched.
 *
 * Used as both the input and return type of `defineConfig()` so consumers can
 * `export default defineConfig({ ... })` and still get IDE jump-to-definition
 * on the inferred shape.
 */
export interface TypedLevelzeroConfig<P extends readonly Plugin<any, any>[]>
  extends Omit<BaseLevelzeroConfig, 'plugins' | 'envInjection'> {
  plugins: P;
  envInjection?: EnvInjectionConfig<P>;
}

/**
 * Authoring-time helper that returns its argument unchanged. Wrap your config
 * object in `defineConfig({ ... })` to get autocomplete on `envInjection`
 * values and compile errors on typos.
 *
 * Runtime no-op — `loadConfig()` doesn't know or care whether a config was
 * produced via `defineConfig()` or written as a plain object literal.
 */
export function defineConfig<P extends readonly Plugin<any, any>[]>(
  cfg: TypedLevelzeroConfig<P>,
): TypedLevelzeroConfig<P> {
  return cfg;
}
