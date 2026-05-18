import { isAbsolute, join } from 'node:path';
import { CLIError } from '../../errors';
import { resolveStackContext } from '../../services/context';
import { AdapterRegistry, getBuiltinAdapters } from '../../adapters/registry';
import type { BackendAdapter } from '../../adapters/backend/types';
import type { FrontendAdapter } from '../../adapters/frontend/types';
import type { Command } from '../types';

/**
 * Default location of the API app inside a levelzero project. Mirrors the
 * `DEFAULT_ENTRY` constant inside the Hono adapter, but expressed as a
 * directory rather than a specific entry file — the command turns this into
 * `<api-dir>/src/index.ts` before handing it to the backend adapter.
 */
const DEFAULT_API_DIR = 'apps/api';

/**
 * Default directory where the generated typed client lands.  Kept in lockstep
 * with the LEV-71 plan; consumers can override via `--out`.
 */
const DEFAULT_OUT_DIR = 'packages/api-client/src';

export interface GenClientOptions {
  /**
   * Backend adapter. When omitted, resolved from the AdapterRegistry returned
   * by `getAdapterRegistry` (default `getBuiltinAdapters()`); tests pass an
   * explicit stub to bypass the registry entirely.
   */
  backendAdapter?: BackendAdapter;
  /**
   * Frontend adapter. When omitted, resolved from the AdapterRegistry returned
   * by `getAdapterRegistry` (default `getBuiltinAdapters()`); tests pass an
   * explicit stub to bypass the registry entirely.
   */
  frontendAdapter?: FrontendAdapter;
  /** AdapterRegistry provider used when either adapter is omitted. */
  getAdapterRegistry?: () => AdapterRegistry;
}

function flagString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveUnderRoot(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

/**
 * Build `levelzero gen client`. Resolves the worktree, asks the backend
 * adapter for a RouteManifest, then hands the manifest + resolved outDir to
 * the frontend adapter. The frontend adapter is the source of truth for the
 * list of files written; the command surfaces them as `generatedFiles`.
 *
 * Flag handling:
 *  * `--api-dir <path>` — relative to the project root; turned into
 *    `<api-dir>/src/index.ts` before being passed to the backend adapter via
 *    its `entry` option. Defaults to `apps/api`.
 *  * `--out <path>` — relative paths are resolved under the project root;
 *    absolute paths are passed through untouched. Defaults to
 *    `packages/api-client/src`.
 */
export function makeGenClientCommand(opts?: GenClientOptions): Command {
  const getAdapterRegistry = opts?.getAdapterRegistry ?? getBuiltinAdapters;
  // Lazy resolution so a swap landed between command construction and run
  // time is honored, and so tests that pass explicit adapters never touch
  // the registry at all.
  const resolveBackend = (): BackendAdapter => {
    if (opts?.backendAdapter) return opts.backendAdapter;
    try {
      return getAdapterRegistry().getActive('backend') as BackendAdapter;
    } catch {
      throw new CLIError(
        'CONFIG_INVALID',
        'no backend adapter configured for `gen client`',
        'load `@levelzero/plugin-hono` (or another backend plugin) in your levelzero.config.ts',
      );
    }
  };
  // Frontend adapter resolution: prefer the explicit injection, then the
  // registry's active impl. After LEV-174 there is no inline fallback to a
  // plugin package — the CLI dispatcher (`bin.ts`) hands `gen client` the
  // merged adapter registry containing the active `frontend` impl
  // contributed by `@levelzero/plugin-typed-client` (or another loaded
  // frontend plugin). When neither path resolves, surface a clear
  // configuration error instead of crashing on an `unknown` cast.
  const resolveFrontend = (): FrontendAdapter => {
    if (opts?.frontendAdapter) return opts.frontendAdapter;
    try {
      return getAdapterRegistry().getActive('frontend') as FrontendAdapter;
    } catch {
      throw new CLIError(
        'CONFIG_INVALID',
        'no frontend adapter configured for `gen client`',
        'load `@levelzero/plugin-typed-client` (or another frontend plugin) in your levelzero.config.ts',
      );
    }
  };

  return {
    name: 'gen.client',
    describe:
      'Generate a typed API client from the backend adapter’s route manifest',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const projectRoot = stackCtx.worktreePath;

      const apiDirFlag = flagString(ctx.flags['api-dir']);
      const outFlag = flagString(ctx.flags['out']);

      const apiDir = apiDirFlag ?? DEFAULT_API_DIR;
      const outDirRel = outFlag ?? DEFAULT_OUT_DIR;
      const outDir = resolveUnderRoot(projectRoot, outDirRel);

      const backendAdapter = resolveBackend();
      const frontendAdapter = resolveFrontend();

      // The backend adapter's `extractRoutes(root, options)` signature is the
      // typed contract — but `BackendAdapter` (the structural type) only
      // exposes the one-arg form. We narrow it here for the optional entry
      // override so a stub that omits the second arg still satisfies the
      // interface for tests that don't pass `--api-dir`.
      let manifest;
      if (apiDirFlag !== undefined) {
        const entry = `${apiDir.replace(/\/$/, '')}/src/index.ts`;
        const extract = backendAdapter.extractRoutes as (
          root: string,
          options?: { entry?: string },
        ) => ReturnType<BackendAdapter['extractRoutes']>;
        manifest = await extract(projectRoot, { entry });
      } else {
        manifest = await backendAdapter.extractRoutes(projectRoot);
      }

      let result;
      try {
        result = await frontendAdapter.generateClient({
          routes: manifest,
          outDir,
        });
      } catch (err) {
        // Surface adapter failures as INTERNAL CLIErrors so the CLI driver
        // returns exit 1 with a structured payload.  Re-raise CLIErrors as-is
        // so callers see the most specific error.
        if (err instanceof CLIError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new CLIError('INTERNAL', `gen client failed: ${msg}`, {
          hint: 'check the backend adapter entry file and the --out path',
        });
      }

      if (ctx.format === 'json') return { generatedFiles: result.files };
      const lines: string[] = [];
      lines.push(`Generated ${result.files.length} file(s) at ${outDir}`);
      for (const f of result.files) lines.push(`  ${f}`);
      return lines.join('\n') + '\n';
    },
  };
}

export const genClientCommand: Command = makeGenClientCommand();
