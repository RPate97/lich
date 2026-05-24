/**
 * Built-in `stack` group adapter (Plan 2 Task 6).
 *
 * The `stack` group is the default env_group every user-defined command and
 * lifecycle entry resolves against unless they say otherwise. It contains
 * exactly the env the stack itself runs with: the merged result of
 * `process.env` + auto-injects + top-level `env_from` / `env_files` / `env`,
 * with all `${...}` references interpolated against the live worktree +
 * allocated-ports context.
 *
 * Plan 1's {@link resolveTopLevelEnv} already produces that exact map for
 * lifecycle hooks. This adapter is a one-call wrapper around it so the
 * Plan 2 groups resolver (`groups/resolve.ts`) can treat `"stack"` as just
 * another group name to dispatch on — same shape, same call signature.
 *
 * WHY this thin adapter exists rather than inlining the call:
 *
 *   `groups/resolve.ts` is the uniform "resolve a group by name" surface.
 *   `stack` is conceptually a group like any other — it just happens to be
 *   hardcoded to map to the top-level env. Inlining `resolveTopLevelEnv`
 *   into `groups/resolve.ts` would couple the groups module to the exact
 *   input shape of `env/resolve.ts`. If that shape ever changes (e.g. Plan
 *   3 layers profile env into the top-level pipeline), every call site in
 *   `groups/resolve.ts` would need touching. With this adapter, the
 *   dependency is one-way: `groups/built-in-stack.ts` imports from
 *   `env/resolve.ts`, and `groups/resolve.ts` only knows the adapter.
 *
 * Resist adding features here. This file is intentionally ~30 LOC of
 * pure wiring; any new behavior belongs in `env/resolve.ts` (so per-service
 * env benefits too) or in `groups/resolve.ts` (so other groups benefit too).
 */

import { resolveTopLevelEnv } from "../env/resolve.js";
import type { ResolveTopLevelEnvInput } from "../env/resolve.js";

/**
 * Input shape for {@link resolveStackGroup}.
 *
 * Identical to {@link ResolveTopLevelEnvInput} from Plan 1 (which is itself
 * `ResolveEnvForServiceInput` minus the `service` discriminator). Aliased
 * here so callers of this module don't have to import from `env/resolve.ts`
 * — they only need to know about `groups/`.
 */
export type ResolveStackGroupInput = ResolveTopLevelEnvInput;

/**
 * Resolve the built-in `stack` env group.
 *
 * Delegates to {@link resolveTopLevelEnv} unchanged. The result is the same
 * env the stack itself uses: process.env + auto-injects (`LICH_WORKTREE`,
 * `LICH_STACK_ID`) + top-level env layers, fully interpolated.
 */
export function resolveStackGroup(
  input: ResolveStackGroupInput,
): Promise<Record<string, string>> {
  return resolveTopLevelEnv(input);
}
