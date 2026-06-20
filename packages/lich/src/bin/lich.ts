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
import { runGlobalHelp, runCommandHelp } from "../commands/help.js";
import { captureCommand, flush as flushTelemetry } from "../telemetry/client.js";
import { isTelemetryEnabled, readLichYamlTelemetry } from "../telemetry/config.js";
import { maybeShowFirstRunNotice } from "../telemetry/notice.js";
import { join } from "node:path";

const argv = mri(process.argv.slice(2), {
  alias: { v: "version", h: "help", y: "yes" },
  // Declare booleans explicitly so mri doesn't swallow a trailing positional as the flag value.
  boolean: [
    "version",
    "help",
    "json",
    "yes",
    "rescue",
    "raw",
    "browser",
    "all",
    "purge",
    "preflight",
    "follow",
  ],
  string: ["env-group", "worktree", "tree", "sort"],
  default: { last: undefined },
});

if (argv.version) {
  console.log(`lich ${VERSION}`);
  process.exit(0);
}

const [commandName, ...rest] = argv._;

// Telemetry: opt-out via LICH_TELEMETRY=0, user config, or lich.yaml runtime.telemetry.
// Show the one-time notice on the very first run when telemetry is enabled.
const telemetryOn = isTelemetryEnabled({
  lichYamlTelemetry: readLichYamlTelemetry(process.cwd()),
});
if (telemetryOn) maybeShowFirstRunNotice();
const commandStartMs = Date.now();

async function exitWithTelemetry(exitCode: number, command: string): Promise<never> {
  if (telemetryOn) {
    captureCommand({ command, exitCode, durationMs: Date.now() - commandStartMs });
    await flushTelemetry();
  }
  process.exit(exitCode);
}

// `--help` short-circuits before any handler runs. Global help when no
// command is given (or when only `--help` is passed); per-command help
// when a name is present.
if (argv.help || !commandName) {
  if (commandName) {
    const r = await runCommandHelp({
      commandName,
      cwd: process.cwd(),
    });
    await exitWithTelemetry(r.exitCode, "help");
  }
  const r = await runGlobalHelp({ cwd: process.cwd() });
  await exitWithTelemetry(r.exitCode, "help");
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
  if (typeof argv.worktree === "string" && argv.worktree.length > 0) {
    const rejection = rejectWorktreeFlag(commandName);
    if (rejection !== null) {
      process.stderr.write(rejection);
      await exitWithTelemetry(2, commandName);
    }
  }

  const handler = COMMANDS[commandName];
  const result = await handler({
    argv: { ...argv, _: rest },
    signal: controller.signal,
  });

  if (result.message) {
    console.log(result.message);
  }

  if (controller.signal.aborted) {
    await exitWithTelemetry(130, commandName);
  }
  if (typeof result.exitCode === "number") {
    await exitWithTelemetry(result.exitCode, commandName);
  }
  await exitWithTelemetry(result.ok ? 0 : 1, commandName);
}

const exitCode = await dispatchUnknown(commandName, rest);
await exitWithTelemetry(exitCode, "custom");

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
  process.stderr.write(`Run 'lich --help' to see available commands.\n`);
  return 2;
}

/**
 * `--worktree` flag gating. `nuke` is destructive — cd-first is the safety
 * net; cross-worktree recovery flows through `--rescue`. `init` / `validate`
 * are cwd-bound by definition. `up`, `stacks`, `dashboard` operate from cwd
 * or are stack-set-wide and have no per-stack target to override.
 */
function rejectWorktreeFlag(commandName: string): string | null {
  if (commandName === "nuke") {
    return (
      "lich nuke: --worktree is not supported (destructive; cd into the worktree first, or use `lich nuke --rescue` to clean cross-worktree leftovers)\n"
    );
  }
  if (commandName === "init" || commandName === "validate") {
    return `lich ${commandName}: --worktree is not supported (this command operates on the current directory)\n`;
  }
  if (commandName === "up") {
    return "lich up: --worktree is not supported (up always brings up the current worktree's stack)\n";
  }
  if (commandName === "stacks") {
    return "lich stacks: --worktree is not supported (lists every stack)\n";
  }
  if (commandName === "dashboard") {
    return "lich dashboard: --worktree is not supported (the dashboard is stack-set-wide)\n";
  }
  return null;
}
