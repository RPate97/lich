import { runInitSync } from "./init.js";
import { runValidate } from "./validate.js";

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
  // runValidate already wrote to stdout/stderr; no extra message.
  return { ok: result.exitCode === 0, message: "" };
};

export const COMMANDS: Record<string, CommandHandler> = {
  up: stub("up"),
  down: stub("down"),
  logs: stub("logs"),
  urls: stub("urls"),
  stacks: stub("stacks"),
  restart: stub("restart"),
  nuke: stub("nuke"),
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
