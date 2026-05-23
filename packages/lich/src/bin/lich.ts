#!/usr/bin/env bun
import mri from "mri";
import { VERSION } from "../version.js";
import { COMMANDS, isCommand } from "../commands/index.js";

const argv = mri(process.argv.slice(2), {
  alias: { v: "version", h: "help" },
  boolean: ["version", "help", "json"],
});

if (argv.version) {
  console.log(`lich ${VERSION}`);
  process.exit(0);
}

const [commandName, ...rest] = argv._;

if (!commandName || argv.help) {
  console.log(`lich ${VERSION}`);
  console.log(`Usage: lich <command> [args]`);
  console.log(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(0);
}

if (!isCommand(commandName)) {
  console.error(`lich: unknown command '${commandName}'`);
  console.error(`Run 'lich --help' to see available commands.`);
  process.exit(2);
}

const handler = COMMANDS[commandName];
const result = await handler({
  argv: { ...argv, _: rest },
});

if (result.message) {
  console.log(result.message);
}
process.exit(result.ok ? 0 : 1);
