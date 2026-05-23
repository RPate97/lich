import { CommandRegistry } from './registry';
import type { Command } from './types';

/**
 * Identifier of a plugin that was loaded into the current dispatch — surfaced
 * in the "LOADED PLUGINS" section of `--help`. Always taken straight from each
 * `Plugin.name` (e.g. `@lich/plugin-portless`). `version` is optional so
 * callers can construct entries without forcing a plugin manifest read; when
 * present it's rendered after the name.
 */
export interface LoadedPluginInfo {
  name: string;
  version?: string;
}

export interface HelpFactoryDeps {
  /**
   * Returns the live `CommandRegistry` whose contents should be rendered.
   * Called at `run()` time so plugin-contributed commands registered after the
   * factory closure was captured still appear.
   */
  getRegistry: () => CommandRegistry;
  /**
   * Returns the plugins that successfully booted for the current dispatch.
   * Empty array = no plugins loaded; rendered as a friendly message rather
   * than an empty section.
   */
  getLoadedPlugins: () => LoadedPluginInfo[];
}

/**
 * Curated render order for command groups. Groups not in this list fall to the
 * end of the rendered help, sorted alphabetically.
 *
 * `core` is the synthetic group for top-level (dot-free) commands. The rest
 * mirror the dotted prefixes used across the inline-registered commands and
 * the plugins shipped from `@lich/plugin-*` after Tier 5.
 */
const GROUP_ORDER: readonly string[] = [
  'core',
  'adapter',
  'stacks',
  'compose',
  'env',
  'db',
  'ui',
  'gen',
  'curl',
  'screenshot',
  'visual',
  'test',
  'check',
  'auth',
];

const GROUP_HEADINGS: Record<string, string> = {
  core: 'CORE COMMANDS',
};

/**
 * Pick the group key for a command from its dotted name. Names without a dot
 * (e.g. `dev`, `init`) land in the synthetic `core` group; dotted names take
 * everything before the first dot as the group (e.g. `stacks.current` →
 * `stacks`, `adapter.list` → `adapter`). This is intentionally lossy — deeper
 * namespaces (`db.migration.new`) collapse to their top-level prefix.
 */
export function groupKey(name: string): string {
  const dot = name.indexOf('.');
  if (dot < 0) return 'core';
  return name.slice(0, dot);
}

/**
 * Split the registered commands into groups keyed by {@link groupKey}, with
 * each group's entries sorted alphabetically by `name`. Returned as a plain
 * object so callers can iterate in their preferred order (the curated
 * {@link GROUP_ORDER} for rendering, but tests may also pull specific groups
 * out by key).
 */
export function groupCommands(commands: Command[]): Record<string, Command[]> {
  const out: Record<string, Command[]> = {};
  for (const cmd of commands) {
    const key = groupKey(cmd.name);
    (out[key] ??= []).push(cmd);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

/**
 * Order the group keys for rendering: curated groups (in {@link GROUP_ORDER})
 * first, in that order, then any remaining groups alphabetically. Only groups
 * actually present in `groups` are returned — empty curated entries are
 * skipped so the rendered help doesn't show stub headers.
 */
export function orderGroupKeys(groups: Record<string, Command[]>): string[] {
  const present = new Set(Object.keys(groups));
  const ordered: string[] = [];
  for (const key of GROUP_ORDER) {
    if (present.has(key)) {
      ordered.push(key);
      present.delete(key);
    }
  }
  const remaining = [...present].sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

/**
 * Pretty heading for a group key. `core` and other curated groups get a fixed
 * label from {@link GROUP_HEADINGS}; everything else is upper-cased verbatim
 * (so `stacks` → `STACKS`, `adapter` → `ADAPTER`, plugin-contributed
 * `db` → `DB`).
 */
function headingFor(key: string): string {
  return GROUP_HEADINGS[key] ?? key.toUpperCase();
}

/**
 * Width to pad the "command name" column to when rendering each line. The
 * widest plugin-contributed name in the wild today (`stacks.stop-all`,
 * `db.migration.new`, ...) sits under 24 chars; we pick 24 so the descriptions
 * line up across groups without recomputing per render. Names longer than 24
 * chars just push the description out — readability still survives.
 */
const NAME_COL_WIDTH = 24;

function renderCommandLine(cmd: Command): string | null {
  // Commands without a `describe` are intentionally skipped so the rendered
  // help doesn't show orphan name-only rows. Every shipped command has one
  // today; this guard is defensive against future plugin contributions.
  if (!cmd.describe || cmd.describe.trim() === '') return null;
  // Render dotted names with spaces — `stacks.current` is invoked as
  // `lich stacks current` so showing it dotted would mislead users about
  // how to type it. The grouping/sort logic still keys on the dotted name.
  const display = cmd.name.replace(/\./g, ' ');
  const padded = display.padEnd(NAME_COL_WIDTH, ' ');
  return `  ${padded} ${cmd.describe}`;
}

function renderGroup(key: string, cmds: Command[]): string[] {
  const lines: string[] = [];
  const rendered = cmds.map(renderCommandLine).filter((l): l is string => l !== null);
  if (rendered.length === 0) return lines;
  lines.push(headingFor(key));
  lines.push(...rendered);
  lines.push('');
  return lines;
}

function renderLoadedPlugins(plugins: LoadedPluginInfo[]): string[] {
  const lines: string[] = ['LOADED PLUGINS'];
  if (plugins.length === 0) {
    lines.push('  (no project plugins loaded — declare them in lich.config.ts)');
  } else {
    const sorted = [...plugins].sort((a, b) => a.name.localeCompare(b.name));
    for (const p of sorted) {
      const suffix = p.version ? ` (${p.version})` : '';
      lines.push(`  ${p.name}${suffix}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Build the full help text for the given registry + loaded-plugin set. Pure
 * (no I/O), so callers can snapshot it in tests. Always ends with a trailing
 * newline so writing it directly to stdout yields a clean prompt.
 */
export function renderHelp(
  registry: CommandRegistry,
  loadedPlugins: LoadedPluginInfo[],
): string {
  const groups = groupCommands(registry.all());
  const order = orderGroupKeys(groups);

  const lines: string[] = [];
  lines.push('lich — extensible dev environment orchestrator');
  lines.push('');
  lines.push('USAGE');
  lines.push('  lich <command> [args] [--flags]');
  lines.push('  lich --help               # show this help');
  lines.push('');

  for (const key of order) {
    const groupCmds = groups[key];
    if (!groupCmds) continue;
    lines.push(...renderGroup(key, groupCmds));
  }

  lines.push(...renderLoadedPlugins(loadedPlugins));

  lines.push('Run `lich <command>` to invoke a command.');

  return lines.join('\n') + '\n';
}

/**
 * Build a `helpCommand` bound to the live dispatch state. Returns a `Command`
 * whose `run()` produces the rendered help string — the bin-level interceptor
 * (and the plain `lich help` route) both call into this same renderer so
 * the output stays in lockstep across invocation styles.
 *
 * Note: the returned command's `run()` returns a `string`, not a structured
 * object. The bin-level interceptor writes that string straight to stdout;
 * dispatching through `runCli` with the default JSON format would JSON-quote
 * it, which is why the interceptor exists at all.
 */
export function makeHelpCommand(deps: HelpFactoryDeps): Command {
  return {
    name: 'help',
    describe: 'Show this help (run `lich --help` for the same output)',
    async run() {
      return renderHelp(deps.getRegistry(), deps.getLoadedPlugins());
    },
  };
}

/**
 * Standalone help command that doesn't depend on a live registry — used by
 * tests and by any consumer that wants a degenerate "no commands registered"
 * help screen. Real CLI dispatch always goes through {@link makeHelpCommand}.
 */
export const helpCommand: Command = makeHelpCommand({
  getRegistry: () => new CommandRegistry(),
  getLoadedPlugins: () => [],
});
