import { runInitSync } from "./init.js";
import { runValidate } from "./validate.js";
import { runUp } from "./up.js";
import { runLogs } from "./logs.js";
import { runUrls } from "./urls.js";
import { runStacks } from "./stacks.js";
import { runNuke } from "./nuke.js";

/**
 * The shape every command returns to the router.
 *
 * `ok` becomes the process exit status: `true` → 0, `false` → 1. The router
 * may also print `message` if non-empty (stubs use it to say "not yet
 * implemented"; real commands typically write their own output and leave
 * `message` empty).
 */
export interface CommandResult {
  ok: boolean;
  message?: string;
}

/**
 * What the router hands a command. `argv` is the parsed-but-unconsumed
 * argv after the command name was peeled off:
 *   `lich validate ./foo --json` → { _: ["./foo"], json: true }.
 */
export interface CommandContext {
  argv: ParsedArgv;
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
      noGitignore: Boolean(ctx.argv["no-gitignore"]),
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
  const result = await runUp({ outputMode: mode as "pretty" | "json" | "quiet" });
  return { ok: result.exitCode === 0, message: "" };
};

// down wiring lands in a follow-up commit once LEV-291's down.ts is on master.
const downHandler: CommandHandler = stub("down");

const logsHandler: CommandHandler = async (ctx) => {
  const [service] = ctx.argv._;
  const follow = ctx.argv["no-follow"] ? false : true;
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
  });
  return { ok: result.exitCode === 0, message: "" };
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
  help: stub("help"),
  exec: stub("exec"),
  env: stub("env"),
};

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}
