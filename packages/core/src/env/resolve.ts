/**
 * Boot-time + per-service EnvSource resolution (Plan 16 / LEV-181).
 *
 * After `bootPlugins` collects every named + bulk EnvSource registration into
 * an {@link EnvSourceRegistry}, two things happen:
 *
 *  1. Boot validates the static shape of `config.envInjection` — every
 *     reference must point at either a known named source key or a namespace
 *     that has a registered bulk source. Anything that can't be ruled
 *     authoritative without awaiting a resolver fails fast here. See
 *     {@link validateEnvInjection} (consumed by `bootPlugins`).
 *  2. For each service the runtime spins up (compose-managed OR host-spawned
 *     owned service), {@link resolveEnvForService} runs:
 *      - Pre-awaits every registered bulk source's `resolve()` exactly once
 *        per resolution session, caching the result (`Map<namespace, env>`).
 *        Failures are wrapped with the contributing plugin's name.
 *      - Applies `importAll` first (so explicit entries override).
 *      - Walks each `[envName, sourceKey]` pair, dispatching on whether the
 *        key matches a named source's full key or a bulk namespace prefix.
 *      - Returns the per-service env map `Record<string, string>`.
 *
 * Host vs container behavior is driven by the `context` argument: named
 * sources pick `host()` vs `container()`; bulk sources receive the context on
 * their `resolve()` call and may branch on it.
 */

import type { EnvSourceContext } from './types';
import type { EnvSourceRegistry } from './registry';
import { BulkResolveError, EnvSourceMissingError } from './errors';

/** Single entry in a config's `envInjection` map: `ENV_VAR -> sourceKey`. */
export type EnvInjectionMap = Record<string, string | string[]>;

/**
 * Cached results of every bulk source's `resolve()` keyed by namespace. The
 * cache is owned by the caller (typically the dispatcher) so multiple
 * {@link resolveEnvForService} calls within a single CLI invocation share
 * work — each bulk source resolves at most once, in parallel, on the first
 * call.
 *
 * The shape is `Map<namespace, Record<envVarName, value>>`. Always lookup-only
 * after {@link prepareBulkResolutions} populates it.
 */
export type BulkResolutionCache = Map<string, Record<string, string>>;

/**
 * Parameters for {@link resolveEnvForService}.
 *
 * `injection` carries the raw `envInjection` block from `LichConfig` —
 * the parser (LEV-180) already validated it's a plain object whose values are
 * `string | string[]`, but didn't check the references resolve.
 *
 * `bulkCache` is reused across calls so the per-boot bulk pre-resolve happens
 * once. If omitted, {@link resolveEnvForService} creates a private cache on
 * the fly — convenient for tests/single-shot use, but inefficient when many
 * services are being resolved back-to-back.
 */
export interface ResolveEnvForServiceInput {
  /** Name of the consumer service — surfaced in error messages. */
  serviceName: string;
  /** Whether this service runs on the host or inside a compose container. */
  context: 'host' | 'container';
  /** Populated registry from `bootPlugins`. */
  registry: EnvSourceRegistry;
  /** The raw `config.envInjection` map (or undefined → empty injection). */
  injection: EnvInjectionMap | undefined;
  /** Stack-allocated `portName -> hostPort`. Passed through to resolvers. */
  ports: Record<string, number>;
  /** Absolute project root — secret-source plugins read config from here. */
  projectRoot: string;
  /** Short worktree identifier — plugins scope per-worktree state under it. */
  worktreeKey: string;
  /** Optional shared cache; created internally if omitted. */
  bulkCache?: BulkResolutionCache;
}

/**
 * Pre-await every bulk source's `resolve()` in parallel and populate
 * `cache`. Each failing resolver is wrapped in a {@link BulkResolveError}
 * with the contributing plugin's name + namespace; the wrapped error
 * surfaces to the caller as `Promise.all`'s rejection.
 *
 * Idempotent: namespaces already present in `cache` are skipped. Use to
 * pre-warm the cache at boot once ports + worktreeKey are known, OR let
 * {@link resolveEnvForService} call it lazily on first use.
 */
export async function prepareBulkResolutions(
  registry: EnvSourceRegistry,
  cache: BulkResolutionCache,
  ctx: EnvSourceContext,
): Promise<void> {
  const pending = registry
    .listBulk()
    .filter((entry) => !cache.has(entry.namespace))
    .map(async (entry) => {
      try {
        const result = await entry.source.resolve(ctx);
        cache.set(entry.namespace, result);
      } catch (err) {
        throw new BulkResolveError(entry.namespace, entry.pluginName, err);
      }
    });
  await Promise.all(pending);
}

/**
 * Resolve `envInjection` for a single service. Returns the merged env map
 * the dispatcher writes into compose `environment:` blocks (for container
 * services) or feeds to `concurrently` (for owned services).
 *
 * Algorithm:
 *
 *   1. Build the resolver context (ports + projectRoot + worktreeKey +
 *      consumer context).
 *   2. Pre-resolve every bulk source into `bulkCache`. Failures wrap with the
 *      contributing plugin's name.
 *   3. Apply `importAll`: for each requested namespace, copy every key from
 *      that bulk source's resolved map into `E`. Missing namespaces in
 *      `importAll` raise {@link EnvSourceMissingError} — the consumer asked
 *      for a bulk source that isn't loaded.
 *   4. Apply explicit entries (`[envName, sourceKey]`):
 *       - If `sourceKey` is a known named source key (`ns.name` exactly):
 *         resolve via `host()` or `container()` and assign.
 *       - Else if `sourceKey` starts with `${ns}.` and `ns` is a registered
 *         bulk namespace: look up the remainder in the resolved bulk map.
 *         If present, assign; if absent, throw `ENV_SOURCE_MISSING`.
 *       - Else: throw `ENV_SOURCE_MISSING`.
 *
 *   Explicit entries always win over `importAll` because step 4 runs after
 *   step 3 and overwrites any key set there.
 */
export async function resolveEnvForService(
  input: ResolveEnvForServiceInput,
): Promise<Record<string, string>> {
  const {
    serviceName,
    context,
    registry,
    injection,
    ports,
    projectRoot,
    worktreeKey,
  } = input;
  const bulkCache = input.bulkCache ?? new Map<string, Record<string, string>>();

  const resolverContext: EnvSourceContext = {
    ports,
    projectRoot,
    worktreeKey,
    consumerContext: context,
  };

  await prepareBulkResolutions(registry, bulkCache, resolverContext);

  const env: Record<string, string> = {};
  if (!injection || Object.keys(injection).length === 0) return env;

  // Step 3 — `importAll`. Comes first so explicit entries in step 4
  // overwrite anything imported wholesale.
  const importAllRaw = injection.importAll;
  const importAll: string[] = Array.isArray(importAllRaw) ? [...importAllRaw] : [];
  for (const ns of importAll) {
    const bulkEntry = registry.getBulk(ns);
    if (!bulkEntry) {
      throw new EnvSourceMissingError(
        ns,
        serviceName,
        loadedNamespaces(registry),
      );
    }
    const resolved = bulkCache.get(ns) ?? {};
    for (const [key, value] of Object.entries(resolved)) {
      env[key] = value;
    }
  }

  // Step 4 — explicit entries. Skip `importAll` (handled above) and any
  // non-string values (the parser already enforced `string | string[]`, but
  // we narrow for safety).
  for (const [envName, sourceKey] of Object.entries(injection)) {
    if (envName === 'importAll') continue;
    if (typeof sourceKey !== 'string') continue;

    const named = registry.getNamed(sourceKey);
    if (named) {
      const resolver = context === 'host' ? named.source.host : named.source.container;
      env[envName] = await resolver(resolverContext);
      continue;
    }

    // Bulk fallback: `${ns}.${runtimeKey}`. We don't require the dot — a
    // bare namespace (no dot) is treated as "missing" since it would be
    // ambiguous with a named source.
    const dotIdx = sourceKey.indexOf('.');
    if (dotIdx > 0) {
      const ns = sourceKey.slice(0, dotIdx);
      const runtimeKey = sourceKey.slice(dotIdx + 1);
      const bulkEntry = registry.getBulk(ns);
      if (bulkEntry && runtimeKey.length > 0) {
        const resolved = bulkCache.get(ns) ?? {};
        if (runtimeKey in resolved) {
          env[envName] = resolved[runtimeKey]!;
          continue;
        }
      }
    }

    throw new EnvSourceMissingError(
      sourceKey,
      serviceName,
      loadedNamespaces(registry),
    );
  }

  return env;
}

/**
 * Boot-time static validation of `envInjection`. Catches what we can know
 * authoritatively without awaiting any bulk resolver:
 *
 *  - Each explicit entry's `sourceKey` must either match a registered named
 *    source's full key OR start with `${ns}.` where `ns` is a registered
 *    bulk namespace. (The runtime key inside a bulk namespace is only
 *    knowable after `resolve()` runs, so it's deferred to
 *    {@link resolveEnvForService}.)
 *  - Each `importAll` entry must reference a registered bulk namespace.
 *
 * `consumerLabel` defaults to `"<config>"` so the error message reads
 * naturally when no specific service is in scope yet.
 *
 * Returns silently on success; throws {@link EnvSourceMissingError} on any
 * unresolvable reference.
 */
export function validateEnvInjection(
  registry: EnvSourceRegistry,
  injection: EnvInjectionMap | undefined,
  consumerLabel = '<config>',
): void {
  if (!injection) return;

  const importAllRaw = injection.importAll;
  const importAll: string[] = Array.isArray(importAllRaw) ? importAllRaw : [];
  for (const ns of importAll) {
    if (!registry.getBulk(ns)) {
      throw new EnvSourceMissingError(ns, consumerLabel, loadedNamespaces(registry));
    }
  }

  for (const [envName, sourceKey] of Object.entries(injection)) {
    if (envName === 'importAll') continue;
    if (typeof sourceKey !== 'string') continue;

    if (registry.getNamed(sourceKey)) continue;

    const dotIdx = sourceKey.indexOf('.');
    if (dotIdx > 0) {
      const ns = sourceKey.slice(0, dotIdx);
      if (registry.getBulk(ns)) continue; // runtime-key check deferred to resolve.
    }

    throw new EnvSourceMissingError(sourceKey, consumerLabel, loadedNamespaces(registry));
  }
}

/**
 * Union of every namespace the registry knows about — combined from both
 * named + bulk registrations. Used in error messages so authors can spot a
 * misspelled namespace at a glance.
 */
function loadedNamespaces(registry: EnvSourceRegistry): string[] {
  const set = new Set<string>();
  for (const entry of registry.listNamed()) set.add(entry.namespace);
  for (const entry of registry.listBulk()) set.add(entry.namespace);
  return [...set].sort();
}
