import { BUILTIN_COMMAND_NAMES } from "./builtin-names.js";
import { runInitSync } from "./init.js";
import { runValidate } from "./validate.js";
import { runUp } from "./up.js";
import { runLogs } from "./logs.js";
import { runUrls } from "./urls.js";
import { runStacks } from "./stacks.js";
import { runNuke } from "./nuke.js";
import { runDown } from "./down.js";
import { runRestart } from "./restart.js";
import { runEnvCmd } from "./env.js";
import { runExec } from "./exec.js";
import { runRouting } from "./routing.js";
import { runDashboard } from "./dashboard.js";
import { runFeedback } from "./feedback.js";
import { sandboxCommand } from "./sandbox.js";

/** `exitCode` overrides the default 0/1 mapping; keep `ok` consistent with it. */
export interface CommandResult {
  ok: boolean;
  message?: string;
  exitCode?: number;
}

export interface CommandContext {
  argv: ParsedArgv;
  signal?: AbortSignal;
}

export interface ParsedArgv {
  _: string[];
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
  const positional = ctx.argv._[0];
  const profile = typeof positional === "string" ? positional : undefined;
  const noBrowser = ctx.argv.browser === false;
  const raw = ctx.argv.raw === true;
  const result = await runUp({
    outputMode: mode as "pretty" | "json" | "quiet",
    signal: ctx.signal,
    profile,
    noBrowser,
    raw,
  });
  return { ok: result.exitCode === 0, message: "" };
};

export function buildDownInput(
  argv: Record<string, unknown> & { _: unknown[] },
  signal?: AbortSignal,
): import("./down.js").RunDownInput {
  const mode: "pretty" | "json" | "quiet" = argv.json
    ? "json"
    : argv.quiet
      ? "quiet"
      : "pretty";
  const input: import("./down.js").RunDownInput = {
    outputMode: mode,
    purge: argv.purge === true,
  };
  if (signal !== undefined) input.signal = signal;
  return input;
}

const downHandler: CommandHandler = async (ctx) => {
  const result = await runDown(buildDownInput(ctx.argv as Record<string, unknown> & { _: unknown[] }, ctx.signal));
  return { ok: result.exitCode === 0, message: "" };
};

const restartHandler: CommandHandler = async (ctx) => {
  const mode = ctx.argv.json
    ? "json"
    : ctx.argv.quiet
      ? "quiet"
      : "pretty";
  const positionals = ctx.argv._.filter((a): a is string => typeof a === "string");
  const services = ctx.argv.all ? ["--all"] : positionals;
  const profile = typeof ctx.argv.profile === "string" ? ctx.argv.profile : undefined;
  const result = await runRestart({
    outputMode: mode as "pretty" | "json" | "quiet",
    signal: ctx.signal,
    services,
    profile,
  });
  return { ok: result.exitCode === 0, message: "", exitCode: result.exitCode };
};

const logsHandler: CommandHandler = async (ctx) => {
  const sources = ctx.argv._.filter((a): a is string => typeof a === "string");
  const follow = ctx.argv.follow === true;
  const all = ctx.argv.all === true;
  const json = ctx.argv.json === true;

  const countRaw = ctx.argv.count ?? ctx.argv.n;
  const count =
    typeof countRaw === "number"
      ? countRaw
      : typeof countRaw === "string"
        ? Number(countRaw)
        : 100;

  const beforeRaw = ctx.argv.before;
  const before =
    typeof beforeRaw === "number"
      ? beforeRaw
      : typeof beforeRaw === "string"
        ? Number(beforeRaw)
        : undefined;

  const afterRaw = ctx.argv.after;
  const after =
    typeof afterRaw === "number"
      ? afterRaw
      : typeof afterRaw === "string"
        ? Number(afterRaw)
        : undefined;

  const grep =
    typeof ctx.argv.grep === "string" ? ctx.argv.grep : undefined;

  const result = runLogs({
    sources: sources.length > 0 ? sources : undefined,
    follow,
    count,
    before,
    after,
    grep,
    all,
    json,
  });
  await result.done;
  return { ok: result.exitCode === 0, message: "" };
};

const urlsHandler: CommandHandler = async (ctx) => {
  const result = await runUrls({ raw: Boolean(ctx.argv.raw) });
  return { ok: result.exitCode === 0, message: "" };
};

const stacksHandler: CommandHandler = async (ctx) => {
  const result = await runStacks({ json: Boolean(ctx.argv.json) });
  return { ok: result.exitCode === 0, message: "" };
};

const nukeHandler: CommandHandler = async (ctx) => {
  const result = await runNuke({
    yes: Boolean(ctx.argv.yes || ctx.argv.y),
    rescue: Boolean(ctx.argv.rescue),
  });
  return { ok: result.exitCode === 0, message: "" };
};

const envHandler: CommandHandler = async (ctx) => {
  const groupName =
    typeof ctx.argv._[0] === "string" ? ctx.argv._[0] : undefined;
  const result = await runEnvCmd({ groupName, cwd: process.cwd() });
  return { ok: result.exitCode === 0, message: "" };
};

const routingHandler: CommandHandler = async (ctx) => {
  const result = await runRouting({ json: Boolean(ctx.argv.json) });
  return { ok: result.exitCode === 0, message: "" };
};

const dashboardHandler: CommandHandler = async (ctx) => {
  const result = await runDashboard({
    noBrowser: Boolean(ctx.argv["no-browser"]),
  });
  return { ok: result.exitCode === 0, message: "" };
};

const feedbackHandler: CommandHandler = async (ctx) => {
  const argv = ctx.argv._.filter((a): a is string => typeof a === "string");
  const file = typeof ctx.argv.file === "string" ? ctx.argv.file : undefined;
  // mri normalizes `--no-context` to `context=false`; honor both spellings
  // so tests passing the flag verbatim still work.
  const noContext =
    ctx.argv["no-context"] === true || ctx.argv.context === false;
  const noBrowser =
    ctx.argv.browser === false || process.env.LICH_NO_BROWSER === "1";
  const result = await runFeedback({
    argv,
    file,
    noContext,
    noBrowser,
    yes: Boolean(ctx.argv.yes || ctx.argv.y),
  });
  return { ok: result.exitCode === 0, message: "", exitCode: result.exitCode };
};

const execHandler: CommandHandler = async (ctx) => {
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
  // Forward specific exit codes (2/127/130/child) verbatim.
  return { ok: result.exitCode === 0, message: "", exitCode: result.exitCode };
};

export const COMMANDS: Record<string, CommandHandler> = {
  up: upHandler,
  down: downHandler,
  logs: logsHandler,
  urls: urlsHandler,
  stacks: stacksHandler,
  restart: restartHandler,
  nuke: nukeHandler,
  init: initHandler,
  validate: validateHandler,
  exec: execHandler,
  env: envHandler,
  routing: routingHandler,
  dashboard: dashboardHandler,
  feedback: feedbackHandler,
  sandbox: sandboxCommand,
};

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string): name is CommandName {
  return name in COMMANDS;
}

// Fail-fast: BUILTIN_COMMAND_NAMES must stay in sync with COMMANDS.
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
