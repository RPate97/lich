#!/usr/bin/env bun
import mri from "mri";
import { VERSION } from "../version.js";
import { COMMANDS, isCommand } from "../commands/index.js";
import { parseConfig } from "../config/parse.js";
import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  type AllocatedPorts,
} from "../state/snapshot.js";
import { dispatchUserCommand } from "../commands/dispatch.js";
import { join } from "node:path";

const argv = mri(process.argv.slice(2), {
  alias: { v: "version", h: "help", y: "yes" },
  // Declare booleans explicitly so mri doesn't swallow a trailing positional as the flag value.
  boolean: ["version", "help", "json", "yes", "rescue", "raw", "browser"],
  string: ["env-group"],
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

// First SIGINT aborts for graceful cleanup; second within the grace window forces exit 130.
const controller = new AbortController();
const SECOND_SIGINT_FORCE_MS = 2000;
let sigintCount = 0;
let firstSigintAt = 0;

const onSigint = (): void => {
  sigintCount += 1;
  const now = Date.now();
  if (sigintCount === 1) {
    firstSigintAt = now;
    process.stderr.write("\nlich: cancelling… (Ctrl-C again to force quit)\n");
    controller.abort();
    return;
  }
  if (now - firstSigintAt <= SECOND_SIGINT_FORCE_MS || sigintCount >= 2) {
    process.stderr.write("lich: forced quit\n");
    process.exit(130);
  }
};

process.on("SIGINT", onSigint);

if (isCommand(commandName)) {
  const handler = COMMANDS[commandName];
  const result = await handler({
    argv: { ...argv, _: rest },
    signal: controller.signal,
  });

  if (result.message) {
    console.log(result.message);
  }

  if (controller.signal.aborted) {
    process.exit(130);
  }
  if (typeof result.exitCode === "number") {
    process.exit(result.exitCode);
  }
  process.exit(result.ok ? 0 : 1);
}

const exitCode = await dispatchUnknown(commandName, rest);
process.exit(exitCode);

async function dispatchUnknown(
  name: string,
  extraArgv: string[],
): Promise<number> {
  const cwd = process.cwd();

  const yamlPath = join(cwd, "lich.yaml");
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    return printUnknownCommand(name);
  }

  if (!parsed.config.commands?.[name]) {
    return printUnknownCommand(name);
  }

  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch {
    return printUnknownCommand(name);
  }

  let allocatedPorts: AllocatedPorts = { compose: {}, owned: {} };
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap) {
    allocatedPorts = rebuildAllocatedPorts(snap);
  }

  const envGroupOverride =
    typeof argv["env-group"] === "string" ? argv["env-group"] : undefined;

  const result = await dispatchUserCommand({
    name,
    extraArgv,
    config: parsed.config,
    worktree,
    allocatedPorts,
    projectRoot: worktree.path,
    envGroupOverride,
    signal: controller.signal,
  });

  return result.exitCode;
}

function printUnknownCommand(name: string): number {
  process.stderr.write(`lich: unknown command '${name}'\n`);
  process.stderr.write(`Run 'lich help' to see available commands.\n`);
  return 2;
}
