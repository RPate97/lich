import type { Plugin, PluginAPI, PluginContext } from '@levelzero/core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parse } from 'dotenv';

/**
 * Options accepted by the `@levelzero/plugin-dotenv` factory.
 *
 *  - `files`           — Relative paths read in declared order; **later files
 *                        win** when keys collide. Paths are resolved against
 *                        `ctx.projectRoot` (the parent repo), NOT the active
 *                        worktree — see the "Worktree safety" note below.
 *                        Missing files are silently skipped so a project can
 *                        ship a `.env` template plus an optional, gitignored
 *                        `.env.local` without forcing every dev to create both.
 *                        Default: `['.env.local']`.
 *  - `fromProcessEnv`  — When `true` (default), the host's `process.env` is
 *                        merged on top of the file contents — useful for
 *                        one-off `FOO=bar levelzero dev` overrides without
 *                        editing any file. Disable to make the resolver
 *                        purely file-driven (deterministic for tests).
 *  - `processEnvKeys`  — Optional allowlist applied to the `process.env`
 *                        passthrough. `'*'` (default) passes every key
 *                        through; an array restricts to exactly the listed
 *                        names. Has no effect when `fromProcessEnv` is `false`.
 *  - `namespace`       — Override the default `dotenv` namespace if a project
 *                        needs two dotenv plugins side-by-side (e.g. one for
 *                        `.env.local`, one for `.env.test`). Rarely needed;
 *                        the literal `'dotenv'` keeps `defineConfig()`
 *                        autocomplete sharp for the common case.
 */
export interface DotenvOptions {
  files?: string[];
  fromProcessEnv?: boolean;
  processEnvKeys?: string[] | '*';
  namespace?: string;
}

/**
 * `@levelzero/plugin-dotenv` (LEV-188).
 *
 * Loads environment variables from `.env`-style files plus (optionally) the
 * host `process.env`, and publishes them as a single **bulk EnvSource** under
 * the `dotenv` namespace. Bulk source semantics fit dotenv perfectly: the keys
 * are determined by whatever the upstream file/env contains, not by the plugin
 * author, so there is no static list of names to register.
 *
 * The plugin is also the **bootstrap layer for secret-loader plugins** —
 * `@levelzero/plugin-infisical` (LEV-189) reads its machine-identity token from
 * `.env.local` via this plugin, then re-publishes the fetched secrets under
 * the `infisical` namespace.
 *
 * ## Precedence (highest priority last)
 *
 * 1. Earlier files in `files`
 * 2. Later files in `files` (later assignments overwrite earlier ones)
 * 3. `process.env` (if `fromProcessEnv` is enabled)
 *
 * This ordering matches the conventional "more-specific wins" expectation: a
 * shared `.env` provides defaults, a developer-local `.env.local` overrides
 * them, and an inline `FOO=bar` invocation overrides everything else.
 *
 * ## Worktree safety
 *
 * Bulk resolvers receive `ctx.projectRoot` — the parent repository root, not
 * the worktree checkout path. `.env.local` lives in the main workspace and is
 * read by every worktree's `levelzero dev`. This is identical to how every
 * other config-reading plugin behaves: `findWorktree` always resolves
 * `projectRoot` to the parent repo regardless of where the worktree itself
 * lives on disk (commonly under `/tmp/levelzero-worktrees/...`).
 *
 * ## Wire it into a project
 *
 * ```ts
 * import dotenv from '@levelzero/plugin-dotenv';
 *
 * export default defineConfig({
 *   plugins: [dotenv()],
 *   envInjection: {
 *     importAll: ['dotenv'],
 *   },
 * });
 * ```
 */
export default function dotenv(opts: DotenvOptions = {}): Plugin<
  'dotenv',
  {
    named: never;
    bulk: true;
  }
> {
  // Resolve defaults once at factory-call time so the registered resolver
  // captures stable values and doesn't re-check `opts` on every boot.
  const files = opts.files ?? ['.env.local'];
  const fromProcessEnv = opts.fromProcessEnv ?? true;
  const allowlist = opts.processEnvKeys ?? '*';

  return {
    name: '@levelzero/plugin-dotenv',
    namespace: (opts.namespace ?? 'dotenv') as 'dotenv',
    version: '0.1.0',

    register(api: PluginAPI<'dotenv'>, _ctx: PluginContext): void {
      api.addBulkEnvSource({
        resolve: ({ projectRoot }) => {
          const result: Record<string, string> = {};

          // File loop — process in declared order so the last assignment
          // for any given key wins. `existsSync` keeps missing files a
          // silent no-op (the common case: `.env.local` is gitignored and
          // not every checkout has one).
          for (const rel of files) {
            const abs = resolvePath(projectRoot, rel);
            if (!existsSync(abs)) continue;
            const parsed = parse(readFileSync(abs, 'utf8'));
            Object.assign(result, parsed);
          }

          // process.env overlay — applied AFTER files so an explicit shell
          // override (`FOO=bar levelzero dev`) wins over a file value.
          // `Object.entries(process.env)` only yields defined values, but
          // the type is `string | undefined`; the runtime guard satisfies
          // both the type-checker and Node's actual behavior.
          if (fromProcessEnv) {
            for (const [k, v] of Object.entries(process.env)) {
              if (v === undefined) continue;
              if (allowlist === '*' || allowlist.includes(k)) {
                result[k] = v;
              }
            }
          }

          return result;
        },
      });
    },
  };
}
