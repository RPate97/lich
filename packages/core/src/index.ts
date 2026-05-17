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
 * Runtime values plugins need to author commands that participate in the CLI's
 * dispatch path (registry lookups, error reporting, worktree resolution,
 * AdapterRegistry access). Kept narrow on purpose — each export is part of the
 * published API surface, so additions here should be deliberate.
 *
 * Added for LEV-152 (`@levelzero/plugin-better-auth`) so the extracted `curl`
 * command can construct a `Registry`, throw `CLIError`, locate the surrounding
 * worktree, and (optionally) resolve auth adapters off the builtin registry —
 * all without reaching into core via deep paths.
 */
export { Registry } from './registry';
export type { StackEntry, RegistryData } from './registry';
export { CLIError } from './errors';
export type { CLIErrorCode, CLIErrorOptions } from './errors';
export { findWorktree, computeWorktreeKey } from './worktree';
export type { Worktree } from './worktree';
export { AdapterRegistry, getBuiltinAdapters } from './adapters/registry';

/**
 * Auth slot contract. Like the other slot interfaces (`BackendAdapter`,
 * `FrontendAdapter`, `TestRunnerAdapter`), the types stay in core even after
 * the concrete `betterAuthAdapter` impl was extracted into
 * `@levelzero/plugin-better-auth` — other core consumers (auth helpers in the
 * plugin, future test fixtures, out-of-tree auth adapters) still need them.
 */
export type {
  AuthAdapter,
  AuthContext,
  CreateUserInput,
  User,
  SessionToken,
  SessionInfo,
} from './adapters/auth/types';

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
