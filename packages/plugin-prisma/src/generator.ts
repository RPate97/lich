import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Generator,
  GeneratorContext,
  GeneratorResult,
  ORMAdapter,
} from '@levelzero/core';
import { prismaAdapter } from './adapter';

/**
 * Build the `prisma` generator (LEV-124).
 *
 * Wraps `prismaAdapter.generateClient(ctx)` — which shells out to
 * `prisma generate --schema prisma/schema.prisma` — under the unified
 * Generator contract so `levelzero gen` can drive it alongside the typed-
 * client codegen from `@levelzero/plugin-typed-client` (and any future
 * plugin-contributed generator) from a single invocation.
 *
 * Skip semantics:
 *   - Returns `status: 'skip'` with a clear reason when the project has no
 *     `prisma/schema.prisma`. Pretty for projects scaffolded without an ORM:
 *     `levelzero gen` reports `[SKIP] prisma` and keeps running siblings
 *     instead of failing the whole run.
 *
 * Failure mode:
 *   - Any non-zero exit from `prisma generate` (or any other surprise) is
 *     re-raised as a thrown Error; the dispatcher converts it to a `fail`
 *     row so one broken generator can't take down the rest of the run.
 *
 * DATABASE_URL resolution: `prisma generate` needs `env("DATABASE_URL")` to
 * resolve to something — even though it never opens a connection, the schema
 * parser validates the env reference. We thread the value via the project's
 * env-source registry when one's registered (matches the cross-plugin
 * composability rule the `db.*` commands follow), and fall back to a
 * placeholder protocol-shaped URL when none is. That keeps the generator
 * runnable for fresh scaffolds that haven't booted a postgres plugin yet
 * (e.g. running `levelzero gen` immediately after `init` on a stack that
 * declares prisma but not a DB plugin).
 */
export function makePrismaGenerator(opts?: { adapter?: ORMAdapter }): Generator {
  const adapter = opts?.adapter ?? prismaAdapter;
  return {
    id: 'prisma',
    describe: 'Generate the Prisma client from prisma/schema.prisma',
    async generate(ctx: GeneratorContext): Promise<GeneratorResult> {
      const schemaPath = join(ctx.projectRoot, 'prisma', 'schema.prisma');
      if (!existsSync(schemaPath)) {
        return {
          status: 'skip',
          message: 'no prisma/schema.prisma found',
        };
      }

      // Best-effort DATABASE_URL resolution. The schema parser needs a value
      // for `env("DATABASE_URL")`, but `prisma generate` doesn't open a
      // connection — a syntactically-valid placeholder is enough when no
      // postgres plugin has wired one up. Real db.* commands resolve via the
      // shared `resolveDatabaseUrl` helper, which throws on missing; here we
      // want the generator to succeed for scaffolds-in-progress that haven't
      // declared a DB plugin yet.
      const databaseUrl = await resolveBestEffortDatabaseUrl(ctx);

      try {
        await adapter.generateClient({
          projectRoot: ctx.projectRoot,
          databaseUrl,
        });
        return { status: 'ok' };
      } catch (err) {
        // LEV-197 — the message MUST include the captured stderr so the
        // `gen` summary renders the actual reason (e.g. "Could not resolve
        // @prisma/client") inline. `makeChildFailureError` in the adapter
        // already builds that string; we forward it verbatim. Non-CLIError
        // throws (e.g. a thrown string from a test stub) fall back to the
        // default Error.message extraction.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          message: msg,
        };
      }
    },
  };
}

/**
 * Resolve a `DATABASE_URL` to hand to `prisma generate` on a best-effort
 * basis. Looks for the first registered named EnvSource whose `name` is
 * `url` AND whose declared `protocol` is `postgres` — same pattern the
 * shared `resolveDatabaseUrl` helper uses for the db.* command family.
 *
 * Falls back to a syntactically-valid placeholder when no source is
 * registered or resolution throws. The placeholder is never used at runtime
 * (no connection is opened); it exists purely to satisfy the schema
 * parser's env-substitution step.
 */
async function resolveBestEffortDatabaseUrl(ctx: GeneratorContext): Promise<string> {
  const PLACEHOLDER = 'postgres://prisma-generate@localhost:5432/placeholder';
  const urlSrc = ctx.envSources.findFirstNamed(
    (entry) => entry.source.protocol === 'postgres' && entry.name === 'url',
  );
  if (!urlSrc) return PLACEHOLDER;
  try {
    return await urlSrc.source.host({
      // Empty ports map — `gen` doesn't run with a stack-allocated port set,
      // and source resolvers that need one will throw which we catch below
      // and fall back to the placeholder.
      ports: {},
      projectRoot: ctx.projectRoot,
      worktreeKey: '',
      consumerContext: 'host',
    });
  } catch {
    return PLACEHOLDER;
  }
}

/** Pre-built generator instance for plugins that want to register it as-is. */
export const prismaGenerator: Generator = makePrismaGenerator();
