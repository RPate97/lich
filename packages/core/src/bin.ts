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
import { uiAddCommand } from './commands/ui/add';
import { uiListCommand } from './commands/ui/list';
import { genClientCommand } from './commands/gen/client';
import { makeUrlsCommand } from './commands/urls';
import { makeCurlCommand } from './commands/curl';
import { composeCommand } from './commands/compose';
import { dbMigrateCommand } from './commands/db/migrate';
import { dbMigrationNewCommand } from './commands/db/migration-new';
import { dbSeedCommand } from './commands/db/seed';
import { dbInspectCommand } from './commands/db/inspect';
import { adapterListCommand, makeAdapterListCommand } from './commands/adapter/list';
import { adapterSwapCommand } from './commands/adapter/swap';
import { AdapterRegistry, getBuiltinAdapters } from './adapters/registry';
import { skillsIndexCommand } from './commands/skills';
import { makeTestCommand } from './commands/test';
import { findWorktree } from './worktree';
import { loadConfig } from './config';
import { bootPlugins } from './plugins/boot';

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
  reg.register(uiAddCommand);
  reg.register(uiListCommand);
  reg.register(genClientCommand);
  reg.register(makeUrlsCommand({ getRegistry: getReg }));
  reg.register(makeCurlCommand({ getRegistry: getReg }));
  reg.register(composeCommand);
  reg.register(dbMigrateCommand);
  reg.register(dbMigrationNewCommand);
  reg.register(dbSeedCommand);
  reg.register(dbInspectCommand);
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

  // Merge plugin-contributed adapters into the built-in registry so
  // `adapter list` reflects the full registered surface. Built-ins are
  // registered first; plugin entries can override a (slot, name) pair via
  // last-write-wins, matching `AdapterRegistry.register` semantics.
  const merged = mergeAdapterRegistries(getBuiltinAdapters(), boot.adapters);
  cli.register(makeAdapterListCommand({ getRegistry: () => merged }));

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

async function main() {
  const cli = await buildDispatchRegistry(process.cwd(), defaultRegistryPath());
  const result = await runCli(process.argv.slice(2), cli, { cwd: process.cwd() });
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
