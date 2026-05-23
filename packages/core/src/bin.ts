#!/usr/bin/env bun
// LEV-114 — Gate the runtime on Node ≥ 20 BEFORE any other import resolves.
// `node:timers/promises` and friends are pulled in transitively by the imports
// below; on an older runtime they throw `ERR_UNKNOWN_BUILTIN_MODULE` with no
// hint about the real fix. Keeping this import + call ordered first (and the
// `node-version` module itself dependency-free) means a too-old Node hits a
// clear, actionable error instead of a cryptic stack trace.
import { checkNodeVersion } from './node-version';
checkNodeVersion();

import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';
import { CommandRegistry } from './commands/registry';
import { Registry } from './registry';
import { initCommand } from './commands/init';
import { makeDoctorCommand } from './commands/doctor';
import { makeStacksCurrentCommand } from './commands/stacks/current';
import { makeStacksListCommand } from './commands/stacks/list';
import { makeStacksPruneCommand } from './commands/stacks/prune';
import { makeDevCommand } from './commands/dev';
import { makeStopCommand } from './commands/stop';
import { makeResetCommand } from './commands/reset';
import { makeRestartCommand } from './commands/restart';
import { makeStacksStopAllCommand } from './commands/stacks/stop-all';
import { makeLogsCommand } from './commands/logs';
import { makeDashboardCommand } from './commands/dashboard';
import { impactCommand } from './commands/impact';
import { coverageCommand } from './commands/coverage';
import { makeCheckCommand } from './commands/check';
import { getBuiltinRules } from './check/builtins';
import { makeScreenshotCommand } from './commands/screenshot';
import { makeVisualDiffCommand } from './commands/visual';
import { makeGenCommand } from './commands/gen';
import { makeUrlsCommand } from './commands/urls';
import { makeComposeCommand } from './commands/compose';
import { adapterListCommand, makeAdapterListCommand } from './commands/adapter/list';
import { adapterSwapCommand, makeAdapterSwapCommand } from './commands/adapter/swap';
import { envListCommand, makeEnvListCommand } from './commands/env/list';
import { envResolveCommand, makeEnvResolveCommand } from './commands/env/resolve';
import { resolveStackContext } from './services/context';
import { AdapterRegistry, getBuiltinAdapters } from './adapters/registry';
import { skillsIndexCommand } from './commands/skills';
import { makeTestCommand } from './commands/test';
import { findWorktree } from './worktree';
import { loadConfig } from './config';
import { bootPlugins } from './plugins/boot';
import { makeHelpCommand, renderHelp, type LoadedPluginInfo } from './commands/help';
import type { BackendAdapter } from './adapters/backend/types';
import type { PortlessAdapter } from './adapters/portless/types';

export const VERSION = '0.0.0';

function defaultRegistryPath(): string {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return join(home, '.levelzero', 'registry.json');
}

/**
 * Build the inline-only command registry — the set of commands that ship with
 * `@levelzero/core` itself and do not depend on a project plugin to function.
 *
 * Post-LEV-165 (Plan 14 Tier 7 cutover) this is the FINAL set of inline
 * registrations. Commands that depend on plugin-contributed adapters /
 * generators (`screenshot`, `visual diff`, `gen`, `test`) are NO LONGER
 * seeded here — they are registered exclusively by {@link buildDispatchRegistry}
 * after `bootPlugins()` runs, with their factories wired against the merged
 * plugin-aware adapter registry. Outside a project (or when the relevant
 * plugins aren't declared in `levelzero.config.ts`) these commands are
 * intentionally absent from the registry, matching the pattern established
 * for `curl`, `db.*`, and `ui.*` in earlier tiers.
 *
 * What stays here: infrastructure / framework commands (`init`, `doctor`,
 * `dev`, `stop`, `reset`, `stacks.*`, `logs`, `impact`, `coverage`, `check`,
 * `urls`, `compose`, `adapter.list`, `adapter.swap`, `env.list`,
 * `env.resolve`, `skills.index`). Several of these are RE-REGISTERED by
 * `buildDispatchRegistry` with plugin-aware closures (e.g. `dev`/`stop`/
 * `reset` pick up `addComposeService`/`addOwnedService` contributions, and
 * `check` rebinds against the active backend adapter for route coverage).
 */
export function buildCommands(registryPath: string): CommandRegistry {
  const reg = new CommandRegistry();
  const getReg = () => new Registry(registryPath);
  reg.register(initCommand);
  reg.register(makeDoctorCommand(getReg));
  reg.register(makeDevCommand(getReg));
  reg.register(makeStopCommand(getReg));
  reg.register(makeResetCommand(getReg));
  reg.register(makeRestartCommand(getReg));
  reg.register(makeStacksCurrentCommand(getReg));
  reg.register(makeStacksListCommand(getReg));
  reg.register(makeStacksPruneCommand(getReg));
  reg.register(makeStacksStopAllCommand(getReg));
  reg.register(makeLogsCommand(getReg));
  reg.register(makeDashboardCommand(() => registryPath));
  reg.register(impactCommand);
  reg.register(coverageCommand);
  reg.register(makeCheckCommand());
  reg.register(makeUrlsCommand({ getRegistry: getReg }));
  reg.register(makeComposeCommand({ getRegistry: getReg }));
  reg.register(adapterListCommand);
  reg.register(adapterSwapCommand);
  reg.register(envListCommand);
  reg.register(envResolveCommand);
  reg.register(skillsIndexCommand);
  return reg;
}

/**
 * Build the dispatch registry for a single CLI invocation. Always seeds the
 * inline registrations from {@link buildCommands} (`init`, `dev`, `stacks.*`,
 * etc.), then — if the invocation is inside a project whose
 * `levelzero.config.ts` declares a non-empty `plugins` array — boots every
 * declared plugin and merges its command contributions on top.
 *
 * After LEV-165 (Plan 14 Tier 7 cutover) the inline seed is intentionally
 * minimal: it covers only the infrastructure commands that don't depend on a
 * plugin-contributed adapter. Plugin-dependent commands (`screenshot`,
 * `visual diff`, `gen`, `test`) are registered here exclusively, with
 * factories closed over the merged plugin-aware adapter/generator registries.
 * Commands fully owned by plugins (`db.*`, `ui.*`, `curl`) flow in via
 * `boot.commands.all()` below. The result: outside a project, only the
 * infrastructure surface is dispatchable; inside a project, the full
 * declared plugin set's commands light up.
 */
export async function buildDispatchRegistry(
  cwd: string,
  registryPath: string,
): Promise<CommandRegistry> {
  const cli = buildCommands(registryPath);

  // Track plugins booted for this dispatch so `--help` can list them under
  // "LOADED PLUGINS". Populated below if (and only if) `bootPlugins` runs;
  // for project-less dispatches and config-less projects it stays empty,
  // which the help renderer handles with a friendly "no plugins" message.
  const loadedPlugins: LoadedPluginInfo[] = [];

  // Register the help command early so even the inline-only dispatch path
  // (no project, no config) gets `--help` / `levelzero help`. The closures
  // capture `cli` and `loadedPlugins` by reference, so plugin commands
  // registered below still appear in the rendered output.
  cli.register(
    makeHelpCommand({
      getRegistry: () => cli,
      getLoadedPlugins: () => loadedPlugins,
    }),
  );

  const wt = await findWorktree(cwd).catch(() => null);
  if (wt === null) return cli;

  let config;
  try {
    config = await loadConfig(wt.configPath);
  } catch {
    // A malformed config shouldn't take down the inline-only dispatch path —
    // commands that need the config (dev, doctor, etc.) will surface the same
    // error themselves with their own context. The fallback path stays usable
    // for `init --force` and other recovery flows.
    return cli;
  }

  if (!config.plugins || config.plugins.length === 0) return cli;

  const boot = await bootPlugins(config, wt.path);
  for (const cmd of boot.commands.all()) {
    cli.register(cmd);
  }
  // Surface the booted plugins to the (already-registered) help command. Push
  // into the captured array rather than reassigning so the closure stays
  // bound to the same reference.
  for (const p of boot.loadedPlugins) {
    loadedPlugins.push(p);
  }

  // Re-register dev/stop/reset with the plugin compose + owned-service
  // contributions piped in (post-LEV-148, post-LEV-154). Without this,
  // services declared via `addComposeService` (e.g. `postgres` from
  // `@levelzero/plugin-postgres`) would not reach the emitted compose file,
  // and `OwnedService` entries contributed via `addOwnedService` (e.g. `web`
  // from `@levelzero/plugin-next`) would not be brought up alongside the
  // built-ins. `bootPlugins` collects both, but the legacy inline command
  // registrations only know about `Service[]`-based contributions.
  // CommandRegistry.register is last-write-wins, so re-registering here
  // overrides the seed entries from `buildCommands` for these three commands.
  const getReg = () => new Registry(registryPath);
  const getPluginCompose = () => boot.compose;
  const getPluginOwnedServices = () => boot.ownedServices;
  // Plan 16 / LEV-182 — thread the env-source registry, the consumer's
  // `envInjection` config, and the shared bulk-resolution cache through to
  // every command that emits a compose file or spawns owned processes. The
  // resolver picks `host()` vs `container()` per-service based on which
  // command path is in scope; all three commands re-use the same registry
  // collected during `bootPlugins`.
  const getEnvSourceRegistry = () => boot.envSources;
  const getEnvInjection = () => config.envInjection;
  const getResolvedBulkSources = () => boot.resolvedBulkSources;
  // LEV-174 — `dev` previously imported `portlessAdapter` and
  // `noopPortlessAdapter` directly from `@levelzero/plugin-portless` and
  // probed `available()` inline. Cutting the core → plugin dep moved that
  // selection to the dispatcher: probe every `portless`-slot impl registered
  // by the boot's plugins and pick the first whose `available()` returns
  // true; fall back to the last registered impl (typically the noop) so
  // `dev`/`reset` still get a typed adapter rather than no wiring at all.
  // Runs eagerly at dispatch-build time so the per-command `getPortlessAdapter`
  // injection can stay synchronous (matches the existing DevOptions contract).
  let selectedPortless: PortlessAdapter | undefined;
  const portlessEntries = boot.adapters.listBySlot('portless');
  if (portlessEntries.length > 0) {
    for (const e of portlessEntries) {
      const impl = e.impl as PortlessAdapter;
      try {
        if (await impl.available()) {
          selectedPortless = impl;
          break;
        }
      } catch {
        // available() shouldn't throw, but if it does treat as unavailable
        // and keep probing siblings.
      }
    }
    if (!selectedPortless) {
      selectedPortless = portlessEntries[portlessEntries.length - 1]!
        .impl as PortlessAdapter;
    }
  }
  const inlineNoopPortlessAdapter: PortlessAdapter = {
    name: 'noop',
    async available() {
      return false;
    },
    async register() {},
    async unregister() {},
    async list() {
      return [];
    },
  };
  const getPortlessAdapter = (): PortlessAdapter =>
    selectedPortless ?? inlineNoopPortlessAdapter;

  const sharedOpts = {
    getPluginCompose,
    getPluginOwnedServices,
    getEnvSourceRegistry,
    getEnvInjection,
    getResolvedBulkSources,
  };
  cli.register(makeDevCommand(getReg, { ...sharedOpts, getPortlessAdapter }));
  cli.register(makeStopCommand(getReg, sharedOpts));
  cli.register(makeResetCommand(getReg, { ...sharedOpts, getPortlessAdapter }));
  cli.register(makeRestartCommand(getReg, sharedOpts));

  // Merge plugin-contributed adapters into the built-in registry so
  // `adapter list` reflects the full registered surface. Built-ins are
  // registered first; plugin entries can override a (slot, name) pair via
  // last-write-wins, matching `AdapterRegistry.register` semantics.
  const merged = mergeAdapterRegistries(getBuiltinAdapters(), boot.adapters);
  cli.register(makeAdapterListCommand({ getRegistry: () => merged }));
  // Register `gen` against the merged plugin-aware registries (LEV-124). The
  // unified command walks every generator the boot collected via
  // `api.addGenerator(...)` — `api-client` from `@levelzero/plugin-typed-client`,
  // `prisma` from `@levelzero/plugin-prisma`, plus any out-of-tree plugin
  // that contributes one. Outside a project (no `BootResult`) the inline
  // seed is omitted entirely; inside a project with no generator-contributing
  // plugins the command still registers and reports the friendly
  // "no generators registered" line.
  cli.register(
    makeGenCommand({
      getGeneratorRegistry: () => boot.generators,
      getEnvSourceRegistry: () => boot.envSources,
      getAdapterRegistry: () => merged,
    }),
  );
  // Re-bind `adapter swap` against the merged registry as well — its
  // validation step (`listBySlot(slot)`) needs to see plugin-contributed
  // (slot, name) pairs. Without this, `adapter swap orm prisma` would fail
  // with "unknown adapter slot 'orm'" post-LEV-149 because the inline
  // registration closes over the bare built-ins.
  cli.register(makeAdapterSwapCommand({ getRegistry: () => merged }));

  // Register `screenshot`, `visual diff`, and `test` against the merged
  // plugin-aware adapter registry. After LEV-165 these are the SOLE
  // registrations for each command — the inline seeds were deleted because
  // none of them can function without a plugin-contributed adapter
  // (`browser` for screenshot/visual diff, `test-runner` for test). Outside
  // a project (or in a project that doesn't declare the relevant plugins)
  // these commands are intentionally absent from the dispatch registry.
  cli.register(makeScreenshotCommand({ getAdapterRegistry: () => merged }));
  cli.register(makeVisualDiffCommand({ getAdapterRegistry: () => merged }));
  cli.register(
    makeTestCommand({ getRegistry: getReg, getAdapterRegistry: () => merged }),
  );

  // Re-bind `check` to a rule set wired with the active backend adapter so
  // the route-coverage rule has something to extract route manifests from.
  // The inline registration in `buildCommands` uses the bare `getBuiltinRules`,
  // which (post-LEV-174) hands back the no-adapter skip-only variant.
  let backendAdapter: BackendAdapter | undefined;
  try {
    backendAdapter = merged.getActive('backend') as BackendAdapter;
  } catch {
    backendAdapter = undefined;
  }
  const checkOpts = backendAdapter
    ? { getRules: () => getBuiltinRules({ backendAdapter }) }
    : { getRules: () => getBuiltinRules() };
  cli.register(makeCheckCommand(checkOpts));

  // Re-bind `env list` / `env resolve` (Plan 16 / LEV-184) against the booted
  // registry so the debug commands can introspect every named + bulk
  // EnvSource a plugin contributed at runtime. The inline registrations in
  // `buildCommands` close over an empty registry, which is the right
  // behavior outside a project but useless once plugins are loaded.
  cli.register(
    makeEnvListCommand({ getEnvSourceRegistry: () => boot.envSources }),
  );
  cli.register(
    makeEnvResolveCommand({
      getEnvSourceRegistry: () => boot.envSources,
      getEnvInjection: () => config.envInjection,
      // Share the per-dispatch bulk-resolution cache with `dev`/`stop`/etc.
      // so a debug `env resolve` immediately after a `dev` reuses already-
      // resolved Infisical/dotenv values rather than refetching them.
      getBulkCache: () => boot.resolvedBulkSources,
      getStackInput: async (cwd) => {
        // Use the running stack's allocated ports if present so the
        // resolved env matches exactly what containers/owned services
        // would see. Outside a registered stack we fall back to an empty
        // port map — resolvers that need a port will surface a clear
        // error, which is the right signal for "your stack isn't up yet".
        const stackCtx = await resolveStackContext(cwd);
        const reg = new Registry(registryPath);
        const entry = await reg.get(stackCtx.worktreeKey);
        return {
          ports: entry?.ports ?? {},
          projectRoot: stackCtx.worktreePath,
          worktreeKey: stackCtx.worktreeKey,
        };
      },
    }),
  );

  return cli;
}

function mergeAdapterRegistries(
  base: AdapterRegistry,
  overlay: AdapterRegistry,
): AdapterRegistry {
  for (const entry of overlay.list()) {
    base.register(entry);
  }
  // Re-apply overlay active selections last so they win over base actives for
  // any slot the overlay touched.
  for (const entry of overlay.list()) {
    try {
      const overlayActive = overlay.getActive(entry.slot);
      const overlayName = overlay
        .listBySlot(entry.slot)
        .find((e) => e.impl === overlayActive)?.name;
      if (overlayName) base.setActive(entry.slot, overlayName);
    } catch {
      // No active impl for this slot in the overlay — leave base's active as-is.
    }
  }
  return base;
}

/**
 * Detect a help invocation from raw argv. Treated as help:
 *   - no args at all (`levelzero`)
 *   - `--help` or `-h` anywhere in argv
 *   - first positional arg is `help` (so `levelzero help` works and the
 *     deferred per-command form `levelzero help <topic>` parses)
 *
 * Returned ahead of dispatch so the rendered output bypasses `runCli`'s
 * JSON-by-default formatting. The dispatched `helpCommand` is still wired
 * into the registry (so `levelzero help` shows up in introspection and the
 * unit tests can exercise it through the normal `Command.run` path); this
 * interceptor exists purely to keep the stdout shape as plain text.
 */
function isHelpInvocation(argv: string[]): boolean {
  if (argv.length === 0) return true;
  if (argv.includes('--help') || argv.includes('-h')) return true;
  const firstPositional = argv.find((a) => !a.startsWith('-'));
  if (firstPositional === 'help') return true;
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const cli = await buildDispatchRegistry(process.cwd(), defaultRegistryPath());

  if (isHelpInvocation(argv)) {
    // The help command is registered into `cli` by `buildDispatchRegistry`
    // and closes over the live registry + loaded-plugin list. Resolve it
    // through the same lookup path other commands use so the rendered help
    // reflects exactly what's dispatchable.
    const help = cli.lookup('help');
    if (help) {
      const rendered = (await help.run({
        cwd: process.cwd(),
        format: 'pretty',
        args: [],
        flags: {},
      })) as string;
      process.stdout.write(rendered);
      process.exit(0);
    }
    // Defensive fallback: registry didn't get a help command for some
    // reason — render directly so users still get something useful.
    process.stdout.write(renderHelp(cli, []));
    process.exit(0);
  }

  const result = await runCli(argv, cli, { cwd: process.cwd() });
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exitCode);
}

// Run when invoked as a script (not when imported).
const invokedAsScript = (() => {
  try {
    return (import.meta as unknown as { main?: boolean }).main === true;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  void main();
}
