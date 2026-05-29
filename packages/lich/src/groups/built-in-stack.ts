/**
 * Built-in `stack` env_group adapter — wraps `resolveTopLevelEnv` so the groups
 * resolver can treat `"stack"` as just another group name. Kept thin so
 * `groups/resolve.ts` doesn't need to know `env/resolve.ts`'s input shape.
 */

import { resolveTopLevelEnv } from "../env/resolve.js";
import type { ResolveTopLevelEnvInput } from "../env/resolve.js";

export type ResolveStackGroupInput = ResolveTopLevelEnvInput;

/**
 * Resolve the built-in `stack` env group: process.env + auto-injects + top-level
 * env layers, fully interpolated.
 */
export function resolveStackGroup(
  input: ResolveStackGroupInput,
): Promise<Record<string, string>> {
  return resolveTopLevelEnv(input);
}
