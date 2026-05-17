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
 * Adapter slot contracts. The slot interfaces stay in core because they are
 * part of the published API surface — even after the concrete impls were
 * extracted into separate plugin packages (`@levelzero/plugin-hono`,
 * `@levelzero/plugin-typed-client`, `@levelzero/plugin-vitest`, etc.),
 * multiple core paths still depend on these shapes, and out-of-tree adapter
 * implementations need them too.
 */
export type {
  FrontendAdapter,
  GenerateClientInput,
} from './adapters/frontend/types';
export type {
  BackendAdapter,
  RouteEntry,
  RouteManifest,
} from './adapters/backend/types';
export type {
  TestResult,
  TestRunInput,
  TestRunnerAdapter,
} from './adapters/test-runner/types';
export type {
  ORMAdapter,
  ORMContext,
  MigrationResult,
  MigrationFile,
  SchemaDescription,
  TableDescription,
  ColumnDescription,
  TableRow,
} from './adapters/orm/types';
