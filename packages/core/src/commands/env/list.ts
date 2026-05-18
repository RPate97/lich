import { EnvSourceRegistry } from '../../env/registry';
import type { Command } from '../types';

/**
 * One row in the rendered/structured `env list` output. Bulk sources have no
 * concrete `name` — we synthesize `${namespace}.*` for the human-readable form
 * and keep the namespace separately for the JSON shape so machine consumers
 * don't have to parse the wildcard string back.
 */
export interface EnvListEntry {
  /** `${namespace}.${name}` for named sources; `${namespace}.*` for bulk. */
  key: string;
  namespace: string;
  /** `null` for bulk sources — only named sources carry a per-name handle. */
  name: string | null;
  kind: 'named' | 'bulk';
  protocol: string | null;
  plugin: string;
}

export interface EnvListResult {
  entries: EnvListEntry[];
}

export interface EnvListOptions {
  /**
   * Provider for the populated registry. Defaults to a fresh, empty
   * {@link EnvSourceRegistry} so the command stays callable from the inline
   * dispatch path (no project / no plugins). Real CLI dispatch overrides this
   * with the registry produced by `bootPlugins` (LEV-181).
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
}

/**
 * Build `levelzero env list`. Returns every named + bulk EnvSource the merged
 * plugin registry knows about, with the contributing plugin and (for named
 * sources) the declared protocol.
 *
 * Output mode is driven by the `--json` flag on the invocation: pretty text
 * by default (this is a debug tool), structured JSON when `--json` is set.
 * The pretty form returns a `string`; the JSON form returns an
 * {@link EnvListResult} the CLI's JSON formatter encodes verbatim.
 */
export function makeEnvListCommand(opts?: EnvListOptions): Command {
  const getRegistry = opts?.getEnvSourceRegistry ?? (() => new EnvSourceRegistry());

  return {
    name: 'env.list',
    describe: 'List every registered EnvSource (named + bulk) with the contributing plugin',
    async run(ctx) {
      const registry = getRegistry();
      const entries = collectEntries(registry);
      if (ctx.flags['json'] === true) {
        return { entries } satisfies EnvListResult;
      }
      return renderPretty(entries);
    },
  };
}

/**
 * Snapshot the registry into a stable list shape for both renderers. Named
 * sources sort before bulk sources, then alphabetically by full key — this
 * matches the pretty render order so a JSON consumer that round-trips the
 * data through `env list --json` gets the same ordering on both passes.
 */
function collectEntries(registry: EnvSourceRegistry): EnvListEntry[] {
  const named: EnvListEntry[] = registry.listNamed().map((entry) => ({
    key: entry.fullKey,
    namespace: entry.namespace,
    name: entry.name,
    kind: 'named' as const,
    protocol: entry.source.protocol ?? null,
    plugin: entry.pluginName,
  }));
  const bulk: EnvListEntry[] = registry.listBulk().map((entry) => ({
    key: `${entry.namespace}.*`,
    namespace: entry.namespace,
    name: null,
    kind: 'bulk' as const,
    protocol: null,
    plugin: entry.pluginName,
  }));
  named.sort((a, b) => a.key.localeCompare(b.key));
  bulk.sort((a, b) => a.namespace.localeCompare(b.namespace));
  return [...named, ...bulk];
}

/**
 * Render the registry entries as a fixed-width 3-column table. Padded by
 * the longest value in each column so columns stay aligned even when a
 * pathologically long plugin name dwarfs the rest. Bulk rows annotate the
 * key with `(bulk)` so a quick scan distinguishes them from named entries.
 */
function renderPretty(entries: EnvListEntry[]): string {
  if (entries.length === 0) {
    return 'no env sources registered\n';
  }

  const rows = entries.map((e) => {
    const sourceLabel = e.kind === 'bulk' ? `${e.key} (bulk)` : e.key;
    const protocolLabel = e.protocol ?? (e.kind === 'bulk' ? '(n/a)' : '-');
    return { source: sourceLabel, protocol: protocolLabel, plugin: e.plugin };
  });

  const headers = { source: 'SOURCE', protocol: 'PROTOCOL', plugin: 'PLUGIN' };
  const widthSource = Math.max(headers.source.length, ...rows.map((r) => r.source.length));
  const widthProtocol = Math.max(headers.protocol.length, ...rows.map((r) => r.protocol.length));

  const lines: string[] = [];
  lines.push(
    `${headers.source.padEnd(widthSource)}  ${headers.protocol.padEnd(widthProtocol)}  ${headers.plugin}`,
  );
  for (const r of rows) {
    lines.push(`${r.source.padEnd(widthSource)}  ${r.protocol.padEnd(widthProtocol)}  ${r.plugin}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Standalone export for the inline-only dispatch path (no project loaded). It
 * resolves an empty registry, so the rendered output is the friendly "no env
 * sources registered" line. Real dispatch rebinds via `makeEnvListCommand`
 * inside `buildDispatchRegistry` so plugin-contributed sources show up.
 */
export const envListCommand: Command = makeEnvListCommand();
