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
  // Explicitly declare every boolean flag here so mri never tries to
  // consume the following positional as the flag's value. `yes`/`rescue`
  // are nuke flags (LEV-311 for rescue); `json` is shared across
  // commands that support structured output.
  boolean: ["version", "help", "json", "yes", "rescue"],
  // Declare `env-group` as a string option so mri parses `--env-group=foo`
  // (and the space-separated `--env-group foo`) into `{ "env-group": "foo" }`
  // without trying to swallow it as a boolean. Used by `lich exec` (LEV-330)
  // and `lich env` (LEV-331) to select which env_group's env to load, and
  // by user-defined command dispatch (LEV-328) as the top-level
  // `--env-group=X` override that overrides a per-command `env_group:`.
  // Other commands ignore it.
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

// ---------------------------------------------------------------------------
// SIGINT handling — LEV-302
// ---------------------------------------------------------------------------
//
// Wire process SIGINT into an AbortController so commands that accept a
// signal (currently `up` and `down`) can cancel in-flight work cleanly:
// abort the ready_when waits, stop spawned owned children, release ports,
// mark state.json failed.
//
//   - First SIGINT:  fires the controller. Commands have a chance to do
//                    graceful cleanup (kill children, release ports,
//                    persist failed state). The handler also prints a
//                    short stderr line so the user knows lich saw the
//                    signal and is winding down.
//   - Second SIGINT within ~2s: `process.exit(130)` immediately. The user
//                    has signalled they really want lich gone NOW; cleanup
//                    in flight is sacrificed. Exit 128+SIGINT(2)=130 is
//                    the convention.
//
// We install the handler unconditionally; commands that don't consume
// `signal` simply ignore it. Without this wiring, ctrl-C would hit Bun's
// default handler and terminate without giving the binary a chance to
// clean up children, release ports, or persist failed state.
const controller = new AbortController();
const SECOND_SIGINT_FORCE_MS = 2000;
let sigintCount = 0;
let firstSigintAt = 0;

const onSigint = (): void => {
  sigintCount += 1;
  const now = Date.now();
  if (sigintCount === 1) {
    firstSigintAt = now;
    // One short line on stderr so the user sees acknowledgement. Use
    // process.stderr.write directly to avoid any console.* buffering.
    process.stderr.write("\nlich: cancelling… (Ctrl-C again to force quit)\n");
    controller.abort();
    return;
  }
  // Second (or later) SIGINT — if it arrived within the grace window, exit
  // immediately with the conventional 128 + SIGINT(2) = 130. Once the user
  // hits Ctrl-C twice their intent is unambiguous; the window keeps "second
  // hit much later" from also forcing.
  if (now - firstSigintAt <= SECOND_SIGINT_FORCE_MS || sigintCount >= 2) {
    process.stderr.write("lich: forced quit\n");
    process.exit(130);
  }
};

process.on("SIGINT", onSigint);

// ---------------------------------------------------------------------------
// Dispatch — LEV-328
// ---------------------------------------------------------------------------
//
// Two paths:
//
//   1. Built-in command. The name lives in COMMANDS; invoke its handler
//      with the standard CommandContext shape.
//   2. Unknown built-in. Fall through to user-defined command dispatch:
//      load `lich.yaml` from cwd; if it parses AND declares a
//      `commands[<name>]` entry, run the user command via
//      `dispatchUserCommand`. If the yaml fails to parse OR the name
//      isn't declared, emit "unknown command" and exit 2.
//
// User commands inherit the SIGINT plumbing wired above — the abort
// controller's signal is threaded into `dispatchUserCommand` exactly the
// same way it is for built-ins, so Ctrl-C reaches a long-running user
// command (e.g. `lich test:e2e` running an integration suite) cleanly.

if (isCommand(commandName)) {
  const handler = COMMANDS[commandName];
  const result = await handler({
    argv: { ...argv, _: rest },
    signal: controller.signal,
  });

  if (result.message) {
    console.log(result.message);
  }

  // If we got here after the abort fired, the conventional exit code for a
  // SIGINT-terminated process is 128 + 2 = 130. The command's `ok: false` is
  // expected (up/down translate "aborted" into a failed result), but using
  // 130 instead of 1 gives shells and scripts the standard signal hint.
  if (controller.signal.aborted) {
    process.exit(130);
  }
  // Honor a command-supplied exit code when present (e.g. `lich exec`
  // surfaces the child's own code, plus distinct codes for usage / 127 /
  // 130). Otherwise fall back to the binary 0/1 mapping driven by `ok`.
  if (typeof result.exitCode === "number") {
    process.exit(result.exitCode);
  }
  process.exit(result.ok ? 0 : 1);
}

// Not a built-in — try user-command dispatch.
const exitCode = await dispatchUnknown(commandName, rest);
process.exit(exitCode);

// ---------------------------------------------------------------------------
// dispatchUnknown — user-command fallback path
// ---------------------------------------------------------------------------

/**
 * Attempt to dispatch `commandName` as a user-defined command declared in
 * the cwd's `lich.yaml`. Three outcomes:
 *
 *   - Config loads AND `commands[name]` exists → invoke
 *     {@link dispatchUserCommand} and forward its exit code (which already
 *     follows POSIX conventions: 127 for missing, 130 for SIGINT, the
 *     child's own code on normal exit).
 *   - Config fails to parse → print "unknown command" with the standard
 *     suggestion and exit 2. User commands REQUIRE a valid config; we
 *     don't want a malformed yaml to silently consume what would otherwise
 *     be a clear "unknown command" diagnostic.
 *   - Config loads BUT `commands[name]` is absent → same as above
 *     (unknown command, exit 2). The dispatch path can't help — there's
 *     no entry to run — so we mirror what the binary did pre-LEV-328.
 *
 * If detecting the worktree fails (e.g. no git repo, no `lich.yaml` in any
 * ancestor) we fall through to the "unknown command" exit 2 path. A user
 * outside a worktree can't run user commands, full stop.
 *
 * State restoration: if `state.json` exists for this worktree, allocated
 * ports get rebuilt and threaded into the env_group resolver so
 * `${owned.X.port}` references interpolate to real allocated ports. If no
 * state (stack is down), we pass an empty allocated-ports map. The user
 * command may fail when interpolating a `${owned.*}` ref, which surfaces
 * as a clear InterpolationError from the env_group resolver — that's a
 * useful failure, not one we want to pre-flight here.
 */
async function dispatchUnknown(
  name: string,
  extraArgv: string[],
): Promise<number> {
  const cwd = process.cwd();

  // ---- 1. Try to load lich.yaml ----------------------------------------
  // parseConfig surfaces ENOENT as a parse failure with kind:"io"; we
  // don't distinguish here — any failure to load means "no user commands
  // are available," and the user sees the standard unknown-command error.
  const yamlPath = join(cwd, "lich.yaml");
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    return printUnknownCommand(name);
  }

  // ---- 2. Is the name declared in commands: ? --------------------------
  if (!parsed.config.commands?.[name]) {
    return printUnknownCommand(name);
  }

  // ---- 3. Build runtime context ----------------------------------------
  // Worktree detection walks up from cwd looking for lich.yaml. We just
  // loaded one from cwd, but detectWorktree may resolve a different root
  // if cwd is a subdirectory of the worktree — that's fine; it gives the
  // canonical worktree identity (the root-most lich.yaml wins).
  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch {
    // No worktree → user commands can't run (they need the worktree's
    // identity for env interpolation, stack_id, etc.). Mirror the
    // "unknown command" exit so the user sees a clear failure mode.
    return printUnknownCommand(name);
  }

  // Allocated ports: rebuilt from state.json when present, empty otherwise.
  // Empty is the legal default — the resolver will throw a useful
  // InterpolationError if the user command references `${owned.X.port}`
  // while no stack is up.
  let allocatedPorts: AllocatedPorts = { compose: {}, owned: {} };
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap) {
    allocatedPorts = rebuildAllocatedPorts(snap);
  }

  // ---- 4. Dispatch -----------------------------------------------------
  // mri parses `--env-group=foo` into `argv["env-group"] = "foo"` (the
  // `string: ["env-group"]` declaration above ensures the value isn't
  // dropped). Forward as the camelCased `envGroupOverride`.
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

  // The dispatcher already returns POSIX-style exit codes — forward
  // verbatim. The 130 convention is baked in there too, so we don't
  // need the same `controller.signal.aborted` check the built-in path
  // uses.
  return result.exitCode;
}

/**
 * Print the standard "unknown command" diagnostic and return exit 2.
 *
 * Exit 2 is what the pre-LEV-328 binary returned for non-built-in names;
 * we preserve that contract so scripts checking for "command did not exist
 * at all" (vs. 127 "command found but failed to run") keep working.
 */
function printUnknownCommand(name: string): number {
  process.stderr.write(`lich: unknown command '${name}'\n`);
  process.stderr.write(`Run 'lich help' to see available commands.\n`);
  return 2;
}
