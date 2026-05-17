import type { AdapterSlot } from '../adapters/registry';
import type { Command } from '../commands/types';
import type { OwnedService } from '../services/types';
import type { Rule } from '../check/types';

// TODO(LEV-124): replace with `import type { Generator } from '../gen/types'`
// once LEV-124 lands. Inlined here as the minimal shape so the plugin contract
// can be defined without a dependency on the not-yet-existent `src/gen/` module.
export interface Generator {
  id: string;
  describe: string;
  generate(ctx: unknown): Promise<unknown>;
}

/**
 * Subset of a Docker Compose v2 service definition that plugins can contribute
 * via `PluginAPI.addComposeService`. Fields mirror the upstream compose schema
 * (snake_case, string-valued durations, etc.) so the merged service map can be
 * serialized straight into a compose file without further translation.
 *
 * Port strings use the `"${PORT}:5432"` form — the host side is a variable so
 * the runner can substitute a stack-allocated port, while the container side
 * is fixed by the image.
 *
 * Intentionally open: additional compose-v2 fields can be added as needed as
 * later waves grow what plugins contribute (e.g. `command`, `user`, `tmpfs`).
 */
export interface ComposeServiceDef {
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  /**
   * Pin the container name (compose-v2 `container_name`). When unset, compose
   * generates `<project>-<service>-<idx>`. Used by `dev`/`stop`/`reset` to
   * preserve the legacy `levelzero-<key>-<service>` naming so registry entries
   * keep working unchanged.
   */
  container_name?: string;
  /** e.g. `["${PORT}:5432"]` — host side typically a variable, container side fixed. */
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: Record<string, { condition: 'service_started' | 'service_healthy' }>;
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  // Additional compose-v2 fields can be added as needed.
}

/** Subset of a compose v2 named-volume definition. */
export interface ComposeVolumeDef {
  driver?: string;
  driver_opts?: Record<string, string>;
  /**
   * Pin the on-disk volume name (compose-v2 `name:`). When unset, compose
   * synthesizes `<project>_<key>`. Used by the docker→compose interim
   * adapter to keep legacy `levelzero-<key>-<service>-data` naming so
   * existing volumes carry over.
   */
  name?: string;
}

/** Subset of a compose v2 named-network definition. */
export interface ComposeNetworkDef {
  driver?: string;
  /** Pin the on-disk network name; see `ComposeVolumeDef.name`. */
  name?: string;
}

/**
 * Surface plugins use to contribute to the running CLI during `register()`.
 *
 * The API is intentionally narrow and additive: every method registers a
 * contribution under a unique key. Mutation of existing contributions is not
 * exposed — plugins should either override by re-registering with the same
 * name (e.g. `addAdapter`) or compose by reading the merged result downstream.
 *
 * Concrete runtime backing this interface lands in later LEV-125 tasks; this
 * file is the types-only contract.
 */
export interface PluginAPI {
  addAdapter(slot: AdapterSlot, name: string, impl: unknown): void;
  setActiveAdapter(slot: AdapterSlot, name: string): void;
  addCommand(cmd: Command): void;
  addOwnedService(service: OwnedService): void;
  addComposeService(name: string, def: ComposeServiceDef): void;
  addComposeVolume(name: string, def: ComposeVolumeDef): void;
  addComposeNetwork(name: string, def: ComposeNetworkDef): void;
  addRule(rule: Rule): void;
  addGenerator(gen: Generator): void;
  addSkillsDir(absPath: string): void;
}

/**
 * Read-only context handed to every plugin's `register()`. Plugins should
 * treat both fields as immutable for the duration of the call.
 *
 * `config` is `unknown` until the project-level config type lands; plugins
 * that need to read it should narrow/parse it themselves.
 */
export interface PluginContext {
  projectRoot: string;
  /** Typed once `LevelzeroConfig` is defined; `unknown` for now. */
  config: unknown;
}

/**
 * The plugin contract. A plugin module exports a `Plugin` (or a default export
 * that satisfies one); the loader calls `register(api, ctx)` exactly once
 * during CLI bootstrap.
 *
 * `register()` may be sync or async — the loader awaits the returned value
 * either way.
 */
export interface Plugin {
  name: string;
  version: string;
  register(api: PluginAPI, ctx: PluginContext): void | Promise<void>;
}
