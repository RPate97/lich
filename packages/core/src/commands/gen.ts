import { CLIError } from '../errors';
import { resolveStackContext } from '../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../adapters/registry';
import { EnvSourceRegistry } from '../env/registry';
import type { GeneratorRegistry } from '../plugins/boot';
import type { Generator, GeneratorContext, GeneratorResult } from '../gen/types';
import type { Command } from './types';

/**
 * Dependency surface for {@link makeGenCommand}. Every field is a closure so
 * production wiring can lazily resolve registries built by `bootPlugins`
 * (whose contents land *after* the command is constructed) while tests can
 * inject pre-populated instances directly.
 *
 * Defaults are deliberately empty — `getGeneratorRegistry` returns `undefined`
 * by default, which makes the command surface a friendly "no generators
 * registered" message rather than crashing. Real CLI dispatch overrides this
 * in `buildDispatchRegistry` with the registry produced by `bootPlugins`.
 */
export interface GenCommandOptions {
  /**
   * Boot-scoped {@link GeneratorRegistry}. Returns `undefined` outside a
   * project / when no plugin contributes a generator.
   */
  getGeneratorRegistry?: () => GeneratorRegistry | undefined;
  /**
   * Boot-scoped {@link EnvSourceRegistry}. Threaded into every
   * {@link GeneratorContext} so generators (e.g. prisma's `DATABASE_URL`
   * lookup) resolve env values through the same path commands use.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /**
   * Boot-scoped {@link AdapterRegistry}. Threaded into every
   * {@link GeneratorContext} so generators (e.g. `api-client` calling
   * `backend.extractRoutes`) resolve adapters through the registry.
   */
  getAdapterRegistry?: () => AdapterRegistry;
}

/**
 * Per-generator entry in the JSON output. Mirrors {@link GeneratorResult}
 * plus the generator's stable `id` so consumers can match results without
 * caring about declaration order.
 */
export interface GenRunEntry {
  id: string;
  status: 'ok' | 'skip' | 'fail';
  message: string | null;
  filesWritten: string[] | null;
}

export interface GenRunResult {
  /** Per-generator outcomes, in declaration order. */
  results: GenRunEntry[];
  /** Number of generators that returned `status: 'ok'`. */
  ok: number;
  /** Number that returned `status: 'skip'`. */
  skipped: number;
  /** Number that returned `status: 'fail'` (or threw). */
  failed: number;
}

/** `--list` JSON shape. Pretty mode renders a 2-column table. */
export interface GenListResult {
  generators: Array<{ id: string; describe: string }>;
}

/**
 * Build `levelzero gen`. The unified codegen entrypoint (LEV-124): walks every
 * generator the plugin registry contributed (or just the subset named by
 * `--only`) and reports per-id status.
 *
 * Flags:
 *   --only <ids>   comma-separated id list. Unknown ids surface as a
 *                  `CONFIG_INVALID` CLIError so typos fail fast.
 *   --list         print the registered generators (id + describe) and exit
 *                  without running anything.
 *   --json         machine-readable shape (see {@link GenRunResult} /
 *                  {@link GenListResult}). LEV-168 default is pretty.
 *
 * Any flag the dispatcher doesn't recognize is passed through verbatim to
 * each `Generator.generate()` via {@link GeneratorContext.flags}. That keeps
 * the door open for generators to grow their own knobs (e.g. `--out` for
 * `api-client`) without `gen` itself needing to know about them.
 *
 * Exit code: 0 when every generator returned `ok` or `skip`; 1 when at
 * least one returned `fail` (or threw). Throws from individual generators are
 * caught and converted to a `fail` row so one broken generator can't take
 * down the rest of the run.
 */
export function makeGenCommand(opts?: GenCommandOptions): Command {
  const getGeneratorRegistry =
    opts?.getGeneratorRegistry ?? ((): undefined => undefined);
  const getEnvSourceRegistry =
    opts?.getEnvSourceRegistry ?? ((): EnvSourceRegistry => new EnvSourceRegistry());
  const getAdapterRegistry =
    opts?.getAdapterRegistry ?? ((): AdapterRegistry => getBuiltinAdapters());

  return {
    name: 'gen',
    describe:
      'Run every registered generator (or a subset via --only); plugin-extensible',
    async run(ctx) {
      // Resolve the project root early so generators always see an absolute
      // path. Generators that need to skip outside a project handle that via
      // their own guard (none do today — the dispatch already requires a
      // booted plugin registry, which only exists inside a project).
      const stackCtx = await resolveStackContext(ctx.cwd);
      const projectRoot = stackCtx.worktreePath;

      const registry = getGeneratorRegistry();
      const all = registry?.all() ?? [];

      // `--list` is a pure introspection mode. Renders before any selection
      // / dispatch happens so it works even when `--only` would fail.
      if (ctx.flags['list']) {
        const generators = all
          .map((g) => ({ id: g.id, describe: g.describe }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (ctx.format === 'json') {
          return { generators } satisfies GenListResult;
        }
        return renderList(generators);
      }

      const onlyFlag = flagString(ctx.flags['only']);
      const selected = onlyFlag ? selectByOnly(all, onlyFlag) : all;

      if (selected.length === 0) {
        const empty: GenRunResult = { results: [], ok: 0, skipped: 0, failed: 0 };
        if (ctx.format === 'json') return empty;
        return registry === undefined || all.length === 0
          ? 'no generators registered\n'
          : 'no generators matched\n';
      }

      // Build the per-generator context once; nothing in it is generator-
      // specific so it can be reused across the whole run. The registries are
      // resolved lazily through the option closures so dispatch wiring can
      // hand in fresh boot-scoped instances each invocation.
      const genCtx: GeneratorContext = {
        projectRoot,
        envSources: getEnvSourceRegistry(),
        adapters: getAdapterRegistry(),
        flags: ctx.flags,
      };

      const results: GenRunEntry[] = [];
      let ok = 0;
      let skipped = 0;
      let failed = 0;
      for (const gen of selected) {
        const entry = await runOne(gen, genCtx);
        results.push(entry);
        if (entry.status === 'ok') ok++;
        else if (entry.status === 'skip') skipped++;
        else failed++;
      }

      if (failed > 0) {
        // Surface failures via a structured CLIError so the CLI driver returns
        // a non-zero exit code while still serializing the per-generator
        // breakdown. Embedding the result rows in `details` keeps the JSON
        // shape introspectable for tooling that wraps `gen`.
        const failedIds = results.filter((r) => r.status === 'fail').map((r) => r.id);
        const summary = renderRun({ results, ok, skipped, failed });
        throw new CLIError(
          'INTERNAL',
          `gen: ${failed} generator(s) failed: ${failedIds.join(', ')}`,
          {
            hint: 'see the per-generator messages above for the underlying error',
            details: { results, ok, skipped, failed, pretty: summary },
          },
        );
      }

      const runResult: GenRunResult = { results, ok, skipped, failed };
      if (ctx.format === 'json') return runResult;
      return renderRun(runResult);
    },
  };
}

/**
 * Resolve a `--only id1,id2,...` list against the registered set. Unknown
 * ids fail fast with a `CONFIG_INVALID` so typos don't silently produce
 * an empty run (which would otherwise look like success).
 */
function selectByOnly(all: Generator[], raw: string): Generator[] {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return [];
  const byId = new Map(all.map((g) => [g.id, g]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const known = all.map((g) => g.id).sort();
    throw new CLIError(
      'CONFIG_INVALID',
      `unknown generator id(s): ${missing.join(', ')}`,
      known.length > 0
        ? `known generators: ${known.join(', ')}`
        : 'no generators registered — declare a plugin that contributes one',
    );
  }
  // Preserve order from `--only` so users can drive sequencing if a generator
  // ever produces inputs another consumes. Today's two generators are
  // independent; the contract still allows it.
  return ids.map((id) => byId.get(id) as Generator);
}

/**
 * Invoke one generator and normalize the outcome into a {@link GenRunEntry}.
 * Catches throws and converts them to `status: 'fail'` so a single broken
 * generator doesn't short-circuit siblings.
 */
async function runOne(gen: Generator, ctx: GeneratorContext): Promise<GenRunEntry> {
  try {
    const r = await gen.generate(ctx);
    return {
      id: gen.id,
      status: r.status,
      message: r.message ?? null,
      filesWritten: r.filesWritten ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: gen.id,
      status: 'fail',
      message: msg,
      filesWritten: null,
    };
  }
}

function flagString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Render `levelzero gen` output as a status table:
 *
 *   [OK] api-client (4 files)
 *   [SKIP] prisma: no prisma/schema.prisma found
 *
 *   gen: 1/2 ok (1 skipped)
 *
 * Counts on the summary line use the same `ok/total` shape every
 * LEV-168-styled command uses so a quick visual scan is consistent.
 */
function renderRun(result: GenRunResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    const tag =
      r.status === 'ok' ? '[OK]' : r.status === 'skip' ? '[SKIP]' : '[FAIL]';
    let line = `${tag} ${r.id}`;
    if (r.status === 'ok' && r.filesWritten && r.filesWritten.length > 0) {
      line += ` (${r.filesWritten.length} file${r.filesWritten.length === 1 ? '' : 's'})`;
    }
    if (r.message) line += `: ${r.message}`;
    lines.push(line);
  }
  const total = result.results.length;
  const trail: string[] = [];
  if (result.skipped > 0) trail.push(`${result.skipped} skipped`);
  if (result.failed > 0) trail.push(`${result.failed} failed`);
  const summary = `gen: ${result.ok}/${total} ok${trail.length > 0 ? ` (${trail.join(', ')})` : ''}`;
  lines.push('');
  lines.push(summary);
  return lines.join('\n') + '\n';
}

function renderList(generators: Array<{ id: string; describe: string }>): string {
  if (generators.length === 0) {
    return 'no generators registered\n';
  }
  const widthId = Math.max('ID'.length, ...generators.map((g) => g.id.length));
  const lines: string[] = [];
  lines.push(`${'ID'.padEnd(widthId)}  DESCRIBE`);
  for (const g of generators) {
    lines.push(`${g.id.padEnd(widthId)}  ${g.describe}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Standalone export for the inline-only dispatch path (no project loaded).
 * Resolves no generators, so the rendered output is the friendly
 * "no generators registered" line. Real dispatch rebinds via
 * `makeGenCommand` inside `buildDispatchRegistry` so plugin-contributed
 * generators show up.
 */
export const genCommand: Command = makeGenCommand();
