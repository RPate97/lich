import { isAbsolute, join } from 'node:path';
import type {
  BackendAdapter,
  FrontendAdapter,
  Generator,
  GeneratorContext,
  GeneratorResult,
} from '@lich/core';
import { typedClientFrontendAdapter } from './adapter';

/**
 * Default location of the API app inside a lich project. Mirrors the
 * `DEFAULT_ENTRY` constant inside the Hono adapter — the generator turns this
 * into `<api-dir>/src/index.ts` before handing it to the backend adapter.
 */
const DEFAULT_API_DIR = 'apps/api';

/**
 * Default directory where the generated typed client lands. Pre-LEV-124 this
 * was the `gen client` command's default; the generator keeps the same path
 * so projects scaffolded against the old behavior stay compatible.
 */
const DEFAULT_OUT_DIR = 'packages/api-client/src';

function flagString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveUnderRoot(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

/**
 * Build the `api-client` generator (LEV-124).
 *
 * Pipeline (unchanged from the retired `gen client` command body):
 *
 *   1. Resolve the active backend adapter (`extractRoutes`) from
 *      {@link GeneratorContext.adapters}. Skip when none is registered —
 *      the typed-client plugin loads cleanly even in projects that haven't
 *      declared a backend plugin.
 *   2. Resolve the active frontend adapter (`generateClient`). Falls back to
 *      this package's `typedClientFrontendAdapter` when no frontend slot is
 *      registered — keeps the generator working even if a future consumer
 *      somehow boots us without `setActiveAdapter('frontend', ...)`.
 *   3. Call `backend.extractRoutes(projectRoot, { entry? })`, threading
 *      `--api-dir` through as the optional `entry` override.
 *   4. Resolve `outDir` from the optional `--out` flag (relative paths
 *      resolved under the project root; absolute paths pass through).
 *   5. Call `frontend.generateClient({ routes, outDir })` and surface the
 *      file list back via {@link GeneratorResult.filesWritten}.
 *
 * Adapter failures are caught and converted to a `fail` result so a missing
 * api entry file (etc.) shows up as a clean row in the `gen` summary instead
 * of taking down sibling generators.
 */
export function makeApiClientGenerator(): Generator {
  return {
    id: 'api-client',
    describe:
      "Generate a typed API client from the active backend adapter's route manifest",
    async generate(ctx: GeneratorContext): Promise<GeneratorResult> {
      let backend: BackendAdapter;
      try {
        backend = ctx.adapters.getActive('backend') as BackendAdapter;
      } catch {
        return {
          status: 'skip',
          message:
            'no active backend adapter — load `@lich/plugin-hono` (or another backend plugin) to enable this generator',
        };
      }
      // Frontend defaults to this package's impl when no plugin contributed
      // a different one — historically `gen client` required the frontend
      // slot to be registered explicitly; we relax that here so the typed-
      // client plugin keeps its own generator usable on a bare load.
      let frontend: FrontendAdapter;
      try {
        frontend = ctx.adapters.getActive('frontend') as FrontendAdapter;
      } catch {
        frontend = typedClientFrontendAdapter;
      }

      const apiDirFlag = flagString(ctx.flags['api-dir']);
      const outFlag = flagString(ctx.flags['out']);
      const outDirRel = outFlag ?? DEFAULT_OUT_DIR;
      const outDir = resolveUnderRoot(ctx.projectRoot, outDirRel);

      // `extractRoutes`'s structural type only exposes the one-arg form. We
      // narrow it here so the optional `entry` override lands without
      // breaking stub adapters in tests (which don't accept the second arg).
      let manifest;
      try {
        if (apiDirFlag !== undefined) {
          const apiDir = apiDirFlag;
          const entry = `${apiDir.replace(/\/$/, '')}/src/index.ts`;
          const extract = backend.extractRoutes as (
            root: string,
            options?: { entry?: string },
          ) => ReturnType<BackendAdapter['extractRoutes']>;
          manifest = await extract(ctx.projectRoot, { entry });
        } else {
          manifest = await backend.extractRoutes(ctx.projectRoot);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          message: `extractRoutes failed: ${msg}`,
        };
      }

      try {
        const result = await frontend.generateClient({ routes: manifest, outDir });
        return {
          status: 'ok',
          filesWritten: result.files,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          message: `generateClient failed: ${msg}`,
        };
      }
    },
  };
}

/** Pre-built generator instance for plugins that want to register it as-is. */
export const apiClientGenerator: Generator = makeApiClientGenerator();
