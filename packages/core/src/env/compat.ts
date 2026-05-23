import type { PluginAPI } from '../plugins/types';
import type { EnvContributions } from '../services/types';
import type { EnvSource, EnvSourceContext } from './types';

/**
 * Plan 16 / LEV-185 — backwards-compat shim for the legacy
 * `Service.envContributions(ports) => Record<string, string>` shape.
 *
 * Pre-Plan 16, plugins published env values by attaching an `envContributions`
 * function to the `DockerService` / `OwnedService` they registered. The new
 * design publishes them via `api.addEnvSource(name, source)` under the
 * plugin's namespace.
 *
 * To avoid a flag-day migration, this shim auto-promotes each legacy contribution
 * into one or more named EnvSource registrations as soon as the service is added
 * during boot. The promotion runs in the same wrapped `PluginAPI` as the rest of
 * the plugin's contributions, so the resulting sources land under
 * `${plugin.namespace}.${env-var-key.toLowerCase()}` — e.g. the legacy
 * `DATABASE_URL` from plugin-postgres becomes `postgres.database_url`.
 *
 * Notes:
 *
 *  - Sampling: the shim calls `envContributions({})` once to discover which keys
 *    the service publishes. Some legacy implementations index `ports.foo`
 *    without guarding — if that throws, we silently fall back to deferred
 *    resolution: no sources get promoted now, but a per-plugin deprecation
 *    warning still fires.
 *  - Duplicate handling: if a plugin already migrated this key via an explicit
 *    `addEnvSource()` call (LEV-187 incrementally migrates plugins), the
 *    `EnvSourceRegistry.registerNamed` throws a collision error. The shim
 *    catches that specific error and silently skips — interpreting it as
 *    "plugin has migrated this key, don't double-register."
 *  - Warning dedupe: the deprecation warning fires at most once per plugin
 *    name per process. {@link _resetWarnedPlugins} clears the dedupe set for
 *    tests.
 *
 * LEV-187 migrates each v0 plugin to explicit `addEnvSource()` calls; once all
 * v0 plugins are migrated the shim sees no `envContributions` functions and
 * stays silent. Plan 17 schedules the shim's removal.
 */
/**
 * Structural shape the shim cares about — accepts both `DockerService` and
 * `OwnedService` without binding to either concrete type. The `envContributions`
 * field is optional here because the shim is the one place in core that has to
 * tolerate services that have already migrated and no longer carry it.
 */
interface LegacyService {
  name: string;
  envContributions?: EnvContributions;
}

const warnedPlugins = new Set<string>();

/**
 * Inspect `service` for a legacy `envContributions` function and, when present,
 * register an equivalent named EnvSource for each key it publishes through the
 * provided {@link PluginAPI}.
 *
 * Returns void; failures during individual source registration (the only
 * realistic one is the duplicate-key collision when LEV-187 has already
 * migrated that key) are caught and ignored. Failures during key discovery
 * (sample call throws) also degrade silently — the legacy contribution simply
 * isn't promoted, but consumers can still construct the value at the legacy
 * call sites that read `service.envContributions(ports)` directly during the
 * transition.
 */
export function promoteEnvContributions(
  service: LegacyService,
  api: PluginAPI,
  pluginName: string,
): void {
  if (typeof service.envContributions !== 'function') return;

  // Sample with an empty `ports` object to discover the key set. We only use
  // the *keys* here; the values are resolved lazily inside the EnvSource
  // closures below using the real port map supplied at resolution time.
  let sampleKeys: string[] = [];
  try {
    const sample = service.envContributions({});
    sampleKeys = Object.keys(sample);
  } catch {
    // Some legacy implementations index `ports.<name>` without guarding —
    // calling with `{}` makes them throw. We can't enumerate the keys in that
    // case, so no sources are auto-promoted. The deprecation warning still
    // fires so the author knows to migrate to `addEnvSource()` (LEV-187), at
    // which point the key set becomes explicit.
    sampleKeys = [];
  }

  for (const key of sampleKeys) {
    // Normalize to lowercase for consistency with the rest of the named-source
    // ecosystem (`postgres.url`, `hono.url`) instead of preserving the legacy
    // SHOUTY_CASE env-var name verbatim. Consumers reading via `envInjection`
    // see lowercased names; the actual env-var name injected into the target
    // process is determined by the consumer's mapping, not by the source key.
    const sourceName = key.toLowerCase();
    const resolveFromService = (ctx: EnvSourceContext): string => {
      const map = service.envContributions!(ctx.ports);
      return map[key]!;
    };
    const source: EnvSource = {
      host: resolveFromService,
      container: resolveFromService,
    };
    try {
      api.addEnvSource(sourceName, source);
    } catch (err) {
      // The only expected error here is the (namespace, name) collision thrown
      // by `EnvSourceRegistry.registerNamed` when the plugin already migrated
      // this key via an explicit `addEnvSource` call (LEV-187). Treat that as
      // "plugin owns this key, leave it alone." Other errors are rethrown so
      // genuine bugs surface.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.startsWith('EnvSource collision')) {
        throw err;
      }
    }
  }

  if (!warnedPlugins.has(pluginName)) {
    warnedPlugins.add(pluginName);
    const promoted = sampleKeys.length;
    console.warn(
      `[lich deprecation] Plugin "${pluginName}" uses Service.envContributions(ports) — please migrate to api.addEnvSource() per Plan 16. Auto-promoted ${promoted} key(s) for now.`,
    );
  }
}

/**
 * Test helper: clear the per-plugin warning dedupe set so the same plugin name
 * can trigger the warning again in a follow-up test. Not part of the public
 * surface — exported solely for `tests/env/compat.test.ts`.
 */
export function _resetWarnedPlugins(): void {
  warnedPlugins.clear();
}
