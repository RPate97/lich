#!/usr/bin/env bun
import mri from "mri";
import { VERSION } from "../version.js";
import { COMMANDS, isCommand } from "../commands/index.js";

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
  // and `lich env` (LEV-331) to select which env_group's env to load. Other
  // commands ignore it.
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

if (!isCommand(commandName)) {
  console.error(`lich: unknown command '${commandName}'`);
  console.error(`Run 'lich --help' to see available commands.`);
  process.exit(2);
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
