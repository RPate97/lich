/**
 * Package entrypoint for `@levelzero/core`.
 *
 * Re-exports the plugin contract (`Plugin`, `PluginAPI`, `PluginContext`,
 * compose contribution shapes, etc.) and a handful of adjacent types that
 * plugins commonly need to type their contributions (`Command`, `OwnedService`,
 * `Rule`, `LevelzeroConfig`, `AdapterSlot`).
 *
 * The full CLI surface (commands, registries, runners) still lives under deep
 * paths; this barrel intentionally exposes only the types a plugin author
 * needs. Adding values here couples the published API to internal layout, so
 * prefer keeping it types-only unless a deliberate runtime helper is needed.
 */
export type {
  Plugin,
  PluginAPI,
  PluginContext,
  ComposeServiceDef,
  ComposeVolumeDef,
  ComposeNetworkDef,
  Generator,
} from './plugins/types';

export type { AdapterSlot, AdapterEntry } from './adapters/registry';
export type { Command, CommandContext } from './commands/types';
export type { OwnedService } from './services/types';
export type { Rule } from './check/types';
export type { LevelzeroConfig, AdaptersConfig, PluginEntry } from './config';

/**
 * Backend slot contract. The `BackendAdapter` interface and its data types
 * stay in core because the slot is part of the published API surface — even
 * after the hono impl was extracted into `@levelzero/plugin-hono`, multiple
 * core paths (frontend/typed-client, commands/gen/client) still depend on
 * these shapes, and out-of-tree backend adapters need them too.
 */
export type {
  BackendAdapter,
  RouteEntry,
  RouteManifest,
} from './adapters/backend/types';
