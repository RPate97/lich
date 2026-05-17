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
  return reg;
}

async function main() {
  const cli = buildCommands(defaultRegistryPath());
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
