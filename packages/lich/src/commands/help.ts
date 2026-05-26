/**
 * `lich help [command]` — discovery surface.
 *
 * Two modes:
 *
 *   1. List mode (`lich help`): prints every built-in command in a curated
 *      order (daily-driver commands first, infrastructure last), and — if a
 *      `lich.yaml` lives in `cwd` AND declares `commands:` — a second section
 *      listing every user-defined command alphabetically with the first line
 *      of its `help:` text as a summary.
 *
 *   2. Per-command mode (`lich help <name>`): prints either the hardcoded
 *      long-form help for a built-in OR the user command's verbatim `help:`
 *      text. Built-ins win on name collision (validate refuses configs whose
 *      user-command names shadow a built-in).
 *
 * The `lich help <built-in>` path does ZERO IO — no yaml load, no fs probe.
 * Only list mode and "unknown built-in, might be a user command" mode load
 * the config.
 *
 * Spec source: docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 5).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import type { UserCommandDef } from "../config/types.js";

// ---------------------------------------------------------------------------
// Built-in help constants
// ---------------------------------------------------------------------------

/**
 * One-line summary for each built-in command. Shown in `lich help` list mode.
 *
 * Keep these short (a single column-friendly sentence). Long-form help text
 * lives in {@link BUILTIN_LONG_HELP} below.
 *
 * **Keep this in sync with `COMMANDS` in `commands/index.ts`.** A built-in
 * without an entry here renders with an empty summary, which is worse than
 * an outdated one.
 */
export const BUILTIN_SUMMARIES: Record<string, string> = {
  up: "Bring the current worktree's stack up.",
  down: "Stop the current worktree's stack and release resources.",
  restart: "Restart the stack (or selected services).",
  logs: "Stream logs from the stack's services.",
  urls: "Print the reachable URLs for the running stack.",
  stacks: "List every running lich stack on this machine.",
  nuke: "Stop every lich stack on this machine and clean state.",
  validate: "Statically analyse a lich.yaml without running anything.",
  init: "Write a starter lich.yaml in the current directory.",
  help: "Show this help, or detailed help for a single command.",
  exec: "Run an ad-hoc command with the stack's resolved env loaded.",
  env: "Print a named env_group as dotenv-format on stdout.",
  routing: "Print the daemon's in-memory routing table (friendly-URL debug).",
};

/**
 * Long-form help text for each built-in command. Printed verbatim by
 * `lich help <name>`. Plain ASCII; no ANSI, no markdown.
 *
 * Keep entries to ~3-10 lines each — enough to describe options, exit codes,
 * and one example.
 */
export const BUILTIN_LONG_HELP: Record<string, string> = {
  up: [
    "Usage: lich up",
    "",
    "Bring the current worktree's stack up. Starts every compose service",
    "and owned process declared by the active profile, runs lifecycle",
    "hooks, and prints a summary with the resolved URLs.",
    "",
    "Exit codes: 0 on success, non-zero on any failure.",
  ].join("\n"),
  down: [
    "Usage: lich down",
    "",
    "Stop the current worktree's stack. Tears down every compose service",
    "and owned process, runs before_down lifecycle hooks, and releases",
    "allocated host ports. State directory is preserved.",
    "",
    "Exit codes: 0 on success, non-zero on failure.",
  ].join("\n"),
  restart: [
    "Usage: lich restart [service ...]",
    "",
    "Restart the whole stack, or the named services only. Respects",
    "depends_on ordering.",
  ].join("\n"),
  logs: [
    "Usage: lich logs [service] [--tail=N] [--no-follow]",
    "",
    "Stream logs from the stack's services. Defaults to tailing all",
    "services with --follow. Pass a service name to filter to one.",
  ].join("\n"),
  urls: [
    "Usage: lich urls [--raw]",
    "",
    "Print every reachable URL for the running stack. By default emits",
    "the friendly <service>.<worktree>.lich.localhost:<proxy-port>",
    "form; --raw prints the underlying localhost:<allocated-port> URLs.",
  ].join("\n"),
  stacks: [
    "Usage: lich stacks [--json]",
    "",
    "List every lich stack currently running on this machine, with",
    "worktree name, status, and uptime. --json emits machine-readable",
    "output.",
  ].join("\n"),
  nuke: [
    "Usage: lich nuke [--yes] [--rescue]",
    "",
    "Stop every lich stack on this machine and clean their state",
    "directories. --rescue scans ~/.lich/started.log and runs idempotent",
    "cleanup for resources state.json no longer references. --yes skips",
    "the confirmation prompt.",
  ].join("\n"),
  validate: [
    "Usage: lich validate [path] [--json]",
    "",
    "Statically analyse a lich.yaml without running anything. Catches",
    "schema errors, unknown depends_on references, dependency cycles,",
    "broken regexes, and bad ${...} interpolations.",
    "",
    "Exit 0 if clean, 1 otherwise.",
  ].join("\n"),
  init: [
    "Usage: lich init [--force] [--no-gitignore]",
    "",
    "Write a starter lich.yaml in the current directory. Also appends",
    ".lich/ to .gitignore unless --no-gitignore is passed. --force",
    "overwrites an existing lich.yaml.",
  ].join("\n"),
  help: [
    "Usage: lich help [command]",
    "",
    "With no argument, lists every built-in command and every",
    "user-defined command from lich.yaml. With a name, prints the",
    "detailed help for that command. Built-ins win on name collision.",
    "",
    "Example: lich help up",
    "",
    "Exit codes: 0 on success, 1 if the named command is unknown.",
  ].join("\n"),
  exec: [
    "Usage: lich exec [--env-group=<group>] <cmd> [args...]",
    "",
    "Run an ad-hoc command with the resolved env loaded. Defaults to",
    "the built-in `stack` env_group; --env-group=<name> picks another.",
    "Stdio is inherited so output streams live.",
    "",
    "Example: lich exec sh -c 'echo $DATABASE_URL'",
    "",
    "Exit codes: 0 on success; child's exit code on failure; 2 on",
    "usage error; 130 on SIGINT.",
  ].join("\n"),
  env: [
    "Usage: lich env <group>",
    "",
    "Print the named env_group as dotenv-format on stdout. Keys are",
    "emitted in sorted order; values are quoted as needed so the",
    "output round-trips through `source <(lich env <group>)`.",
    "",
    "Example: source <(lich env stack)",
    "",
    "Exit codes: 0 on success; 1 when the group is unknown; 2 on",
    "usage error (no group name given).",
  ].join("\n"),
  routing: [
    "Usage: lich routing",
    "",
    "Print the daemon's in-memory routing table as JSON. Useful when",
    "a friendly URL (host:port from `lich urls`) 404s — compare what",
    "the daemon has loaded against the routing entries in state.json.",
    "",
    "Exit codes: 0 on success; non-zero if the daemon is unreachable.",
  ].join("\n"),
};

/**
 * Curated display order for built-ins in `lich help`'s list mode.
 *
 * Daily-driver commands first (`up`, `down`, `restart`, `logs`, `urls`,
 * `stacks`), then infrastructure (`nuke`, `validate`, `init`), then the
 * discovery surfaces (`help`, `exec`, `env`). Alphabetical mixes
 * daily-driver commands with destructive infrastructure (e.g. `nuke`
 * next to `logs`) in a way that obscures discovery.
 */
const BUILTIN_DISPLAY_ORDER: readonly string[] = [
  "up",
  "down",
  "restart",
  "logs",
  "urls",
  "stacks",
  "nuke",
  "validate",
  "init",
  "help",
  "exec",
  "env",
  "routing",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HelpOptions {
  /**
   * The optional second positional, e.g. `lich help up`. When absent, the
   * handler enters list mode.
   */
  commandName?: string;
  /**
   * Directory to resolve `lich.yaml` from (for user-command discovery).
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
  /** Sink for normal output (defaults to console.log). */
  stdout?: (line: string) => void;
  /** Sink for error output (defaults to console.error). */
  stderr?: (line: string) => void;
}

export interface HelpResult {
  exitCode: 0 | 1;
}

/**
 * Run the help command. See the file-level JSDoc for behavior summary.
 */
export async function runHelp(opts: HelpOptions = {}): Promise<HelpResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));

  // ---- per-command mode ---------------------------------------------------
  if (opts.commandName) {
    return runPerCommandHelp(opts.commandName, cwd, out, err);
  }

  // ---- list mode ----------------------------------------------------------
  return runListHelp(cwd, out);
}

// ---------------------------------------------------------------------------
// Per-command mode
// ---------------------------------------------------------------------------

async function runPerCommandHelp(
  commandName: string,
  cwd: string,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<HelpResult> {
  // Built-in path: zero IO.
  if (BUILTIN_LONG_HELP[commandName]) {
    out(BUILTIN_LONG_HELP[commandName]);
    return { exitCode: 0 };
  }

  // Might be a user command. Load lich.yaml and check.
  const userCmd = await tryLookupUserCommand(commandName, cwd);
  if (userCmd) {
    // Print name and the user's help text verbatim. If no help text given,
    // surface the cmd so `lich help <name>` is still informative.
    out(`lich ${commandName}`);
    out("");
    if (userCmd.help && userCmd.help.trim().length > 0) {
      out(userCmd.help.replace(/\n$/, ""));
    } else {
      out(`(no help text)`);
      out(`cmd: ${userCmd.cmd}`);
    }
    return { exitCode: 0 };
  }

  err(`lich: unknown command '${commandName}'`);
  return { exitCode: 1 };
}

// ---------------------------------------------------------------------------
// List mode
// ---------------------------------------------------------------------------

async function runListHelp(
  cwd: string,
  out: (line: string) => void,
): Promise<HelpResult> {
  // ---- built-ins ----------------------------------------------------------
  out("Built-in commands:");
  const nameWidth = BUILTIN_DISPLAY_ORDER.reduce(
    (n, name) => Math.max(n, name.length),
    0,
  );
  for (const name of BUILTIN_DISPLAY_ORDER) {
    const summary = BUILTIN_SUMMARIES[name] ?? "";
    out(`  ${name.padEnd(nameWidth)}  ${summary}`);
  }

  // ---- user commands (only if lich.yaml present with commands) -----------
  const userCommands = await tryLoadUserCommands(cwd);
  if (userCommands && Object.keys(userCommands).length > 0) {
    out("");
    out("User-defined commands (from lich.yaml):");
    const names = Object.keys(userCommands).sort();
    const userNameWidth = names.reduce((n, name) => Math.max(n, name.length), 0);
    for (const name of names) {
      const def = userCommands[name];
      const summary = firstLine(def.help) ?? "(no help text)";
      out(`  ${name.padEnd(userNameWidth)}  ${summary}`);
    }
  }

  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Load `commands:` from `lich.yaml` if the file is present and parses cleanly.
 *
 * Returns null on any failure (missing file, yaml parse error, schema error).
 * `lich help` is a discovery surface — it must not crash on a broken yaml.
 * If users want diagnostics they can run `lich validate`.
 */
async function tryLoadUserCommands(
  cwd: string,
): Promise<Record<string, UserCommandDef> | null> {
  const yamlPath = join(cwd, "lich.yaml");
  if (!existsSync(yamlPath)) return null;
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) return null;
  return parsed.config.commands ?? null;
}

async function tryLookupUserCommand(
  name: string,
  cwd: string,
): Promise<UserCommandDef | null> {
  const commands = await tryLoadUserCommands(cwd);
  if (!commands) return null;
  return commands[name] ?? null;
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf("\n");
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
