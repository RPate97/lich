/**
 * `--help` rendering. `runGlobalHelp` is the `lich --help` surface
 * (built-ins + user-defined commands). `runCommandHelp` is the
 * `lich <cmd> --help` surface (long-form per-command help).
 * Built-in help is zero-IO; only list/user-command paths load yaml.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import type { LichConfig, UserCommandDef } from "../config/types.js";

export const BUILTIN_SUMMARIES: Record<string, string> = {
  up: "Bring the current worktree's stack up.",
  down: "Stop the current worktree's stack and release resources.",
  restart: "Restart the stack (or selected services).",
  logs: "Stream logs from the stack's services.",
  urls: "Print the reachable URLs for the running stack.",
  stacks: "List every running lich stack on this machine.",
  top: "Live per-service CPU + memory view (table or JSON).",
  nuke: "Stop every lich stack on this machine and clean state.",
  validate: "Statically analyse a lich.yaml without running anything.",
  init: "Write a starter lich.yaml in the current directory.",
  exec: "Run an ad-hoc command with the stack's resolved env loaded.",
  env: "Print a named env_group as dotenv-format on stdout.",
  routing: "Print the daemon's in-memory routing table (friendly-URL debug).",
  dashboard: "Open the lich dashboard in the default browser.",
};

/** Long-form help text per built-in. Printed verbatim; plain ASCII. */
export const BUILTIN_LONG_HELP: Record<string, string> = {
  up: [
    "Usage: lich up [profile]",
    "",
    "Bring the current worktree's stack up. Starts every compose service",
    "and owned process declared by the active profile, runs lifecycle",
    "hooks, and prints a summary with the resolved URLs.",
    "",
    "With no argument, activates the default profile. Pass a profile",
    "name to activate it explicitly.",
    "",
    "Flags:",
    "  --json          Emit machine-readable progress on stdout.",
    "  --quiet         Suppress progress; print final summary only.",
    "  --browser       Open the dashboard in the browser after up. (Default: don't open; run `lich dashboard` to open later.)",
    "  --raw           Print raw localhost URLs in the summary.",
    "",
    "Exit codes: 0 on success, non-zero on any failure.",
  ].join("\n"),
  down: [
    "Usage: lich down [--worktree <id-or-name>]",
    "",
    "Stop the current worktree's stack. Tears down every compose service",
    "and owned process, runs before_down lifecycle hooks, and releases",
    "allocated host ports. State directory is preserved.",
    "",
    "Flags:",
    "  --json                  Emit machine-readable progress on stdout.",
    "  --quiet                 Suppress progress; print final summary only.",
    "  --worktree <id-or-name> Target a stack by ID or worktree name instead",
    "                          of the current directory (see `lich stacks`).",
    "",
    "Exit codes: 0 on success, non-zero on failure.",
  ].join("\n"),
  restart: [
    "Usage: lich restart [service ...] [--worktree <id-or-name>]",
    "",
    "Restart the whole stack, or the named services only. Respects",
    "depends_on ordering.",
    "",
    "Flags:",
    "  --json                  Emit machine-readable progress on stdout.",
    "  --quiet                 Suppress progress; print final summary only.",
    "  --worktree <id-or-name> Target a stack by ID or worktree name instead",
    "                          of the current directory (see `lich stacks`).",
  ].join("\n"),
  logs: [
    "Usage: lich logs [service] [--tail=N] [--no-follow] [--worktree <id-or-name>]",
    "",
    "Stream logs from the stack's services. Defaults to tailing all",
    "services with --follow. Pass a service name to filter to one.",
    "",
    "Flags:",
    "  --tail=N                Show the last N lines (default 50 with --follow,",
    "                          200 with --no-follow).",
    "  --no-follow             Print existing logs and exit; do not stream.",
    "  --worktree <id-or-name> Target a stack by ID or worktree name instead",
    "                          of the current directory (see `lich stacks`).",
  ].join("\n"),
  urls: [
    "Usage: lich urls [--raw] [--worktree <id-or-name>]",
    "",
    "Print every reachable URL for the running stack. By default emits",
    "the friendly <service>.<worktree>.lich.localhost:<proxy-port>",
    "form; --raw prints the underlying localhost:<allocated-port> URLs.",
    "",
    "Flags:",
    "  --raw                   Emit raw localhost URLs instead of friendly form.",
    "  --worktree <id-or-name> Target a stack by ID or worktree name instead",
    "                          of the current directory (see `lich stacks`).",
  ].join("\n"),
  stacks: [
    "Usage: lich stacks [--json]",
    "",
    "List every lich stack currently running on this machine, with",
    "worktree name, status, and uptime. --json emits machine-readable",
    "output.",
    "",
    "Both renderers read from the same in-memory snapshot — every value",
    "shown in the table is derivable from --json.",
    "",
    "JSON shape (array; one entry per stack, sorted by worktree_name):",
    "  [",
    "    {",
    '      "stack_id": string,            // opaque ID, stable across `up`s',
    '      "worktree_name": string,       // basename of the worktree dir',
    '      "status": "starting" | "up" | "partial" | "stopping" |',
    '                "stopped" | "failed",',
    '      "lifecycle"?: {                // present iff lifecycle hooks ran',
    '        "before_up"?: PhaseStatus,',
    '        "after_up"?:  PhaseStatus,',
    '        "before_down"?: PhaseStatus,',
    '        "after_down"?:  PhaseStatus',
    "      },",
    '      "started_at": string,          // ISO 8601 timestamp',
    '      "uptime_seconds": number,',
    '      "services": [',
    "        {",
    '          "name": string,',
    '          "kind": "owned" | "compose",',
    '          "state": "starting" | "healthy" | "initializing" |',
    '                   "ready" | "stopping" | "stopped" | "failed"',
    "        }",
    "      ],",
    '      "primary_url"?: string,        // first service with allocated ports',
    '      "active_profile"?: string      // omitted if no profile was active',
    "    }",
    "  ]",
    "",
    "PhaseStatus =",
    '  { "status": "ok" }',
    '  | { "status": "not_run" }',
    "  | {",
    '      "status": "failed",',
    '      "failed_index": number,        // zero-based',
    '      "total": number,',
    '      "failed_cmd": string,          // truncated to 80 chars + "..."',
    '      "log_path": string             // per-phase log file',
    "    }",
    "",
    "Types live in packages/lich/src/state/snapshot.ts:",
    "  StackSnapshot, ServiceSnapshot, StackStatus, ServiceState,",
    "  LifecyclePhaseStatus, LifecycleSnapshotStatus",
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
  exec: [
    "Usage: lich exec [--env-group=<group>] [--no-preflight] [--worktree <id-or-name>] <cmd> [args...]",
    "",
    "Run an ad-hoc command with the resolved env loaded. Defaults to",
    "the built-in `stack` env_group; --env-group=<name> picks another.",
    "Stdio is inherited so output streams live.",
    "",
    "If the stack isn't up, a one-line warning is printed to stderr but",
    "the command still runs. Use --no-preflight to suppress the warning",
    "(handy in scripts).",
    "",
    "Flags:",
    "  --env-group=<group>     Resolve env from the named env_group (default: stack).",
    "  --no-preflight          Suppress the stack-not-up warning.",
    "  --worktree <id-or-name> Target a stack by ID or worktree name instead",
    "                          of the current directory (see `lich stacks`).",
    "                          The command runs in that worktree's directory.",
    "",
    "Example: lich exec sh -c 'echo $DATABASE_URL'",
    "",
    "Exit codes: 0 on success; child's exit code on failure; 2 on",
    "usage error; 130 on SIGINT.",
  ].join("\n"),
  env: [
    "Usage: lich env <group> [--worktree <id-or-name>]",
    "",
    "Print the named env_group as dotenv-format on stdout. Keys are",
    "emitted in sorted order; values are quoted as needed so the",
    "output round-trips through `source <(lich env <group>)`.",
    "",
    "Flags:",
    "  --worktree <id-or-name> Resolve the env_group against the named stack",
    "                          instead of the current directory.",
    "",
    "Example: source <(lich env stack)",
    "",
    "Exit codes: 0 on success; 1 when the group is unknown; 2 on",
    "usage error (no group name given).",
  ].join("\n"),
  routing: [
    "Usage: lich routing [--worktree <id-or-name>]",
    "",
    "Print the daemon's in-memory routing table as JSON. Useful when",
    "a friendly URL (host:port from `lich urls`) 404s — compare what",
    "the daemon has loaded against the routing entries in state.json.",
    "",
    "Flags:",
    "  --json                  Emit the table as JSON (default: table form).",
    "  --worktree <id-or-name> Filter to entries from the named stack only.",
    "",
    "Exit codes: 0 on success; non-zero if the daemon is unreachable.",
  ].join("\n"),
  dashboard: [
    "Usage: lich dashboard [--no-browser]",
    "",
    "Open the lich dashboard (http://lich.localhost:<proxy-port>/) in",
    "the default browser. Auto-starts the daemon if needed; can be run",
    "from any directory.",
    "",
    "Flags:",
    "  --no-browser    Print the URL only; skip the browser open.",
    "                  (Also honored via LICH_NO_BROWSER=1.)",
    "",
    "Exit codes: 0 on success; non-zero if the daemon fails to start",
    "or its reverse proxy is unavailable.",
  ].join("\n"),
  top: [
    "Usage: lich top [--no-follow] [--json] [--all] [--worktree <id-or-name>]",
    "                [--tree <service>] [--sort cpu|mem|name] [--interval N]",
    "",
    "Live per-service CPU + memory view. Follows by default, refreshing",
    "every 2s; Ctrl-C exits cleanly. Owned services aggregate the full",
    "process tree (parent + forked workers); compose services pull from",
    "`docker stats`.",
    "",
    "Flags:",
    "  --no-follow             Print one snapshot and exit (default: follow).",
    "  --json                  Machine-readable; implies --no-follow.",
    "  --all                   Every running stack on this machine.",
    "  --worktree <id-or-name> Target another worktree's stack.",
    "  --tree <service>        Expand the process tree for one owned service.",
    "  --sort cpu|mem|name     Service sort order (default: cpu).",
    "  --interval N            Refresh interval in seconds (default: 2).",
    "",
    "JSON shape:",
    "  {",
    '    "stack_id": string,',
    '    "sampled_at": string (ISO 8601),',
    '    "total": { "cpu_pct": number, "mem_bytes": number },',
    '    "services": [',
    "      {",
    '        "name": string,',
    '        "kind": "owned" | "compose",',
    '        "state": string,',
    '        "pid"?: number,                  // owned only',
    '        "container_id"?: string,         // compose only',
    '        "cpu_pct": number,',
    '        "mem_bytes": number,',
    '        "mem_limit_bytes"?: number,      // compose only',
    '        "uptime_seconds": number,',
    '        "process_count"?: number         // owned only',
    "      }",
    "    ]",
    "  }",
    "",
    "Note: the first sample of any owned service shows 0% CPU until the",
    "second sample lands (ps's CPU% is cumulative; the daemon diffs across",
    "two samples to derive current).",
    "",
    "Exit codes: 0 on success; 1 if the daemon is unreachable; 2 on usage",
    "error.",
  ].join("\n"),
};

/** Display order: daily-drivers → infrastructure → discovery. Alphabetical mixes destructive commands with safe ones. */
export const BUILTIN_DISPLAY_ORDER: readonly string[] = [
  "up",
  "down",
  "restart",
  "logs",
  "urls",
  "dashboard",
  "stacks",
  "top",
  "nuke",
  "validate",
  "init",
  "exec",
  "env",
  "routing",
];

export interface HelpOptions {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface CommandHelpOptions extends HelpOptions {
  commandName: string;
}

export interface HelpResult {
  exitCode: 0 | 1;
}

/** `lich --help` — global help: intro + list of every built-in (+ user-defined). */
export async function runGlobalHelp(
  opts: HelpOptions = {},
): Promise<HelpResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));

  out("lich — worktree-scoped dev stack orchestrator.");
  out("");
  out("Usage: lich <command> [args] [--help]");
  out("");
  out("Built-in commands:");
  const nameWidth = BUILTIN_DISPLAY_ORDER.reduce(
    (n, name) => Math.max(n, name.length),
    0,
  );
  for (const name of BUILTIN_DISPLAY_ORDER) {
    const summary = BUILTIN_SUMMARIES[name] ?? "";
    out(`  ${name.padEnd(nameWidth)}  ${summary}`);
  }

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

  out("");
  out("Run `lich <command> --help` for detailed help on a command.");

  return { exitCode: 0 };
}

/** `lich <cmd> --help` — per-command help: usage line + flags + examples. */
export async function runCommandHelp(
  opts: CommandHelpOptions,
): Promise<HelpResult> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.stdout ?? ((s: string) => console.log(s));
  const err = opts.stderr ?? ((s: string) => console.error(s));
  const commandName = opts.commandName;

  if (BUILTIN_LONG_HELP[commandName]) {
    out(BUILTIN_LONG_HELP[commandName]);
    const ctx = await loadBuiltinContext(commandName, cwd);
    if (ctx) {
      out("");
      out(ctx);
    }
    return { exitCode: 0 };
  }

  const userCmd = await tryLookupUserCommand(commandName, cwd);
  if (userCmd) {
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

/**
 * Contextual config for a built-in. Returns an extra block to append to the
 * long-help text, or null if no context is available. Currently only `up`
 * lists the profiles declared in the local lich.yaml. Best-effort: returns
 * null on any IO/parse error so built-in help stays useful without yaml.
 */
async function loadBuiltinContext(
  commandName: string,
  cwd: string,
): Promise<string | null> {
  if (commandName !== "up") return null;
  const config = await tryLoadConfig(cwd);
  if (!config) return null;
  const profiles = config.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) return null;

  const lines: string[] = [];
  lines.push("Available profiles (from lich.yaml):");
  const sorted = [...names].sort();
  const nameWidth = sorted.reduce((n, x) => Math.max(n, x.length), 0);
  for (const name of sorted) {
    const def = profiles[name];
    const tag = def?.default ? "  (default)" : "";
    lines.push(`  ${name.padEnd(nameWidth)}${tag}`);
  }
  return lines.join("\n");
}

/** Returns null on any failure — help must not crash on broken yaml. */
async function tryLoadConfig(cwd: string): Promise<LichConfig | null> {
  const yamlPath = join(cwd, "lich.yaml");
  if (!existsSync(yamlPath)) return null;
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) return null;
  return parsed.config;
}

async function tryLoadUserCommands(
  cwd: string,
): Promise<Record<string, UserCommandDef> | null> {
  const config = await tryLoadConfig(cwd);
  if (!config) return null;
  return config.commands ?? null;
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
