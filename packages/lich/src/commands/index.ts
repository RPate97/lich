import { BUILTIN_COMMAND_NAMES } from "./builtin-names.js";
import { runInitSync } from "./init.js";
import { runValidate } from "./validate.js";
import { runUp } from "./up.js";
import { runLogs } from "./logs.js";
import { runUrls } from "./urls.js";
import { runStacks } from "./stacks.js";
import { runNuke } from "./nuke.js";
import { runDown } from "./down.js";
import { runHelp } from "./help.js";
import { runEnvCmd } from "./env.js";
import { runExec } from "./exec.js";

/**
 * The shape every command returns to the router.
 *
 * `ok` is the headline pass/fail: `true` → exit 0 by default, `false` →
 * exit 1 by default. The router may also print `message` if non-empty
 * (stubs use it to say "not yet implemented"; real commands typically
 * write their own output and leave `message` empty).
 *
 * `exitCode` overrides the default 0/1 mapping when a command needs to
 * surface a specific POSIX exit code distinct from generic success/failure.
 * Examples (from `lich exec`, LEV-330): `2` for usage errors, `127` for
 * "command not found", `130` for SIGINT-cancelled child. When present, the
 * router uses this value directly; when absent, it falls back to the `ok`
 * mapping. Commands MUST keep `ok` and `exitCode` consistent — pass
 * `ok: false` whenever `exitCode !== 0` so any caller reading just `ok`
 * (e.g. tests asserting on success/failure shape) still sees the right
 * answer.
 */
export interface CommandResult {
  ok: boolean;
  message?: string;
  exitCode?: number;
}

/**
 * What the router hands a command. `argv` is the parsed-but-unconsumed
 * argv after the command name was peeled off:
 *   `lich validate ./foo --json` → { _: ["./foo"], json: true }.
 *
 * `signal` is an optional AbortSignal the bin layer wires to the process's
 * SIGINT handler so commands can react to Ctrl-C (cancel in-flight ready
 * waits, kill spawned children, release ports). Tests may also pass their
 * own controller's signal to exercise the cancellation path directly.
 */
export interface CommandContext {
  argv: ParsedArgv;
  signal?: AbortSignal;
}

export interface ParsedArgv {
  /** Positional args after the command name. */
  _: string[];
  /** Any other flags/options parsed by mri. */
  [key: string]: unknown;
}

export type CommandHandler = (
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>;

function stub(name: string): CommandHandler {
  return () => ({
    ok: false,
    message: `'lich ${name}' is not yet implemented`,
  });
}

const initHandler: CommandHandler = (ctx) => {
  const result = runInitSync(
    {
      force: Boolean(ctx.argv.force),
      // mri parses `--no-gitignore` into `{ gitignore: false }`, NOT
      // `{ "no-gitignore": true }`. Check the explicit boolean instead.
      noGitignore: ctx.argv.gitignore === false,
    },
    process.cwd(),
  );
  return { ok: result.exitCode === 0, message: result.messages.join("\n") };
};

const validateHandler: CommandHandler = async (ctx) => {
  const [path] = ctx.argv._;
  const json = Boolean(ctx.argv.json);
  const result = await runValidate({ path, json });
  return { ok: result.exitCode === 0, message: "" };
};

const upHandler: CommandHandler = async (ctx) => {
  const mode = ctx.argv.json
    ? "json"
    : ctx.argv.quiet
      ? "quiet"
      : "pretty";
  const result = await runUp({
    outputMode: mode as "pretty" | "json" | "quiet",
    signal: ctx.signal,
  });
  return { ok: result.exitCode === 0, message: "" };
};

const downHandler: CommandHandler = async (ctx) => {
  const result = await runDown({ signal: ctx.signal });
  return { ok: result.exitCode === 0, message: "" };
};

const logsHandler: CommandHandler = async (ctx) => {
  const [service] = ctx.argv._;
  // mri parses `--no-follow` into `{ follow: false }`, NOT
  // `{ "no-follow": true }`. Check the explicit boolean instead.
  // Default to follow=true when neither flag is passed.
  const follow = ctx.argv.follow !== false;
  const tail =
    typeof ctx.argv.tail === "number"
      ? ctx.argv.tail
      : typeof ctx.argv.tail === "string"
        ? Number(ctx.argv.tail)
        : follow
          ? 50
          : 200;
  const result = runLogs({ service, follow, tail });
  await result.done;
  return { ok: result.exitCode === 0, message: "" };
};

const urlsHandler: CommandHandler = async () => {
  const result = await runUrls({});
  return { ok: result.exitCode === 0, message: "" };
};

const stacksHandler: CommandHandler = async (ctx) => {
  const result = await runStacks({ json: Boolean(ctx.argv.json) });
  return { ok: result.exitCode === 0, message: "" };
};

const nukeHandler: CommandHandler = async (ctx) => {
  const result = await runNuke({
    yes: Boolean(ctx.argv.yes || ctx.argv.y),
    // LEV-311: --rescue scans `~/.lich/started.log` and runs
    // idempotent cleanup for every spawned resource, regardless of
    // whether state.json still references it.
    rescue: Boolean(ctx.argv.rescue),
  });
  return { ok: result.exitCode === 0, message: "" };
};

const helpHandler: CommandHandler = async (ctx) => {
  // First positional after `help` (e.g. `lich help up` → "up").
  const commandName =
    typeof ctx.argv._[0] === "string" ? ctx.argv._[0] : undefined;
  const result = await runHelp({ commandName, cwd: process.cwd() });
  return { ok: result.exitCode === 0, message: "" };
};

const envHandler: CommandHandler = async (ctx) => {
  // First positional after `env` (e.g. `lich env stack` → "stack").
  const groupName =
    typeof ctx.argv._[0] === "string" ? ctx.argv._[0] : undefined;
  const result = await runEnvCmd({ groupName, cwd: process.cwd() });
  return { ok: result.exitCode === 0, message: "" };
};

const execHandler: CommandHandler = async (ctx) => {
  // The router strips the command name (`exec`) and leaves everything else
  // in `ctx.argv._`. mri also parses `--env-group=<X>` into the camelCased
  // `env-group` key (the bin layer registers it as a string option so mri
  // doesn't try to swallow the following positional as the flag's value).
  const envGroupName =
    typeof ctx.argv["env-group"] === "string"
      ? ctx.argv["env-group"]
      : undefined;
  const result = await runExec({
    argv: ctx.argv._,
    envGroupName,
    cwd: process.cwd(),
    signal: ctx.signal,
  });
  // Forward the specific exit code (2/127/130/child's own code) so users
  // and scripts can distinguish "usage error" from "command not found"
  // from "child failed with N". Default 0/1 mapping would erase this.
  return { ok: result.exitCode === 0, message: "", exitCode: result.exitCode };
};

export const COMMANDS: Record<string, CommandHandler> = {
  up: upHandler,
  down: downHandler,
  logs: logsHandler,
  urls: urlsHandler,
  stacks: stacksHandler,
  restart: stub("restart"),
  nuke: nukeHandler,
  init: initHandler,
  validate: validateHandler,
  help: helpHandler,
  exec: execHandler,
  env: envHandler,
};

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}

// Fail-fast: keep BUILTIN_COMMAND_NAMES (used by validate.ts to refuse
// user commands that shadow a built-in) in sync with the COMMANDS map.
// A missing handler — or a name in COMMANDS not in the list — is a
// programming bug, not a runtime condition.
{
  const handlerNames = new Set(Object.keys(COMMANDS));
  const listNames = new Set<string>(BUILTIN_COMMAND_NAMES);
  for (const n of BUILTIN_COMMAND_NAMES) {
    if (!handlerNames.has(n)) {
      throw new Error(
        `BUILTIN_COMMAND_NAMES lists "${n}" but COMMANDS has no handler for it`,
      );
    }
  }
  for (const n of handlerNames) {
    if (!listNames.has(n)) {
      throw new Error(
        `COMMANDS has handler "${n}" not present in BUILTIN_COMMAND_NAMES`,
      );
    }
  }
}
