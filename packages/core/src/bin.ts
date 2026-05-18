#!/usr/bin/env bun
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
import { makeStacksStopAllCommand } from './commands/stacks/stop-all';
import { makeLogsCommand } from './commands/logs';
import { impactCommand } from './commands/impact';
import { coverageCommand } from './commands/coverage';
import { makeCheckCommand } from './commands/check';
import { screenshotCommand } from './commands/screenshot';
import { visualDiffCommand } from './commands/visual';
import { genClientCommand, makeGenClientCommand } from './commands/gen/client';
import { makeUrlsCommand } from './commands/urls';
import { composeCommand } from './commands/compose';
import { adapterListCommand, makeAdapterListCommand } from './commands/adapter/list';
import { adapterSwapCommand, makeAdapterSwapCommand } from './commands/adapter/swap';
import { AdapterRegistry, getBuiltinAdapters } from './adapters/registry';
import { skillsIndexCommand } from './commands/skills';
import { makeTestCommand } from './commands/test';
import { findWorktree } from './worktree';
import { loadConfig } from './config';
import { bootPlugins } from './plugins/boot';
import { makeHelpCommand, renderHelp, type LoadedPluginInfo } from './commands/help';

export const VERSION = '0.0.0';

function defaultRegistryPath(): string {
  const home = process.env['LEVELZERO_HOME'] ?? homedir();
  return join(home, '.levelzero', 'registry.json');
}

export function buildCommands(registryPath: string): CommandRegistry {
  const reg = new CommandRegistry();
  const getReg = () => new Registry(registryPath);
  reg.register(initCommand);
  reg.register(makeDoctorCommand(getReg));
  reg.register(makeDevCommand(getReg));
  reg.register(makeStopCommand(getReg));
  reg.register(makeResetCommand(getReg));
  reg.register(makeStacksCurrentCommand(getReg));
  reg.register(makeStacksListCommand(getReg));
  reg.register(makeStacksPruneCommand(getReg));
  reg.register(makeStacksStopAllCommand(getReg));
  reg.register(makeLogsCommand(getReg));
  reg.register(impactCommand);
  reg.register(coverageCommand);
  reg.register(makeCheckCommand());
  reg.register(screenshotCommand);
  reg.register(visualDiffCommand);
  reg.register(genClientCommand);
  reg.register(makeUrlsCommand({ getRegistry: getReg }));
  reg.register(composeCommand);
  reg.register(adapterListCommand);
  reg.register(adapterSwapCommand);
  reg.register(skillsIndexCommand);
  reg.register(makeTestCommand({ getRegistry: getReg }));
  return reg;
}

/**
 * Build the dispatch registry for a single CLI invocation. Always seeds the
 * inline registrations from {@link buildCommands} (`init`, `dev`, `stacks.*`,
 * etc.), then — if the invocation is inside a project whose
 * `levelzero.config.ts` declares a non-empty `plugins` array — boots every
 * declared plugin and merges its command contributions on top.
 *
 * This is the transitional wiring for LEV-130. The inline registrations remain
 * the source of truth for built-in commands; plugins can layer additional
 * commands (or override an inline one with a same-named contribution, since
 * `CommandRegistry.register` is last-write-wins). A later tier will move the
 * built-ins themselves into plugins and cut the seam.
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
  cli.register(makeDevCommand(getReg, { getPluginCompose, getPluginOwnedServices }));
  cli.register(makeStopCommand(getReg, { getPluginCompose, getPluginOwnedServices }));
  cli.register(makeResetCommand(getReg, { getPluginCompose, getPluginOwnedServices }));

  // Merge plugin-contributed adapters into the built-in registry so
  // `adapter list` reflects the full registered surface. Built-ins are
  // registered first; plugin entries can override a (slot, name) pair via
  // last-write-wins, matching `AdapterRegistry.register` semantics.
  const merged = mergeAdapterRegistries(getBuiltinAdapters(), boot.adapters);
  cli.register(makeAdapterListCommand({ getRegistry: () => merged }));
  // Re-bind `gen.client` to the merged registry too so commands that depend
  // on plugin-contributed adapters (e.g. `backend` after LEV-150 extracted
  // hono into `@levelzero/plugin-hono`) actually see them at dispatch time.
  // The inline `genClientCommand` registered above closes over the built-in
  // registry only, which after the extraction has no active `backend` impl.
  cli.register(makeGenClientCommand({ getAdapterRegistry: () => merged }));
  // Re-bind `adapter swap` against the merged registry as well — its
  // validation step (`listBySlot(slot)`) needs to see plugin-contributed
  // (slot, name) pairs. Without this, `adapter swap orm prisma` would fail
  // with "unknown adapter slot 'orm'" post-LEV-149 because the inline
  // registration closes over the bare built-ins.
  cli.register(makeAdapterSwapCommand({ getRegistry: () => merged }));

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
