/**
 * `pickDefaultProfile` — single-default enforcement helper (Plan 3 Task 3).
 *
 * Profiles may opt into being the implicit selection for `lich up` (no
 * positional argument) by setting `default: true`. The spec requires at most
 * one such profile per config; this helper enforces that invariant and
 * surfaces the chosen name (or the error) to the two call sites that need it:
 *
 *   - `lich up` (Plan 3 Task 13): when no profile argument is supplied, pick
 *     the default. No default + non-empty `profiles` map is an error there.
 *   - `lich validate` (Plan 3 Task 11): rejects configs whose `profiles` map
 *     declares two or more defaults.
 *
 * Both callers consume the same discriminated shape `{ name, error? }` —
 * neither throws, because the two contexts want different downstream
 * handling of the "no default" case (a hard error for `up`, a no-op for
 * `validate`).
 *
 * Pure function: no I/O, no async. Sorts the offending profile names
 * alphabetically in the error message for deterministic test output.
 */

import type { LichConfig } from "../config/types.js";

/**
 * Inspect `config.profiles` and pick the single profile flagged `default: true`.
 *
 *   - Absent / empty `profiles` map: `{ name: null }`.
 *   - No profile sets `default: true`: `{ name: null }`. (Caller decides
 *     whether this is an error.)
 *   - Exactly one profile sets `default: true`: `{ name: <that-name> }`.
 *   - Two or more profiles set `default: true`: `{ name: null, error }` where
 *     `error` lists the offending names alphabetically.
 */
export function pickDefaultProfile(
  config: LichConfig,
): { name: string | null; error?: string } {
  const profiles = config.profiles;
  if (!profiles) return { name: null };
  const defaults = Object.entries(profiles)
    .filter(([, def]) => def.default === true)
    .map(([name]) => name)
    .sort();
  if (defaults.length === 0) return { name: null };
  if (defaults.length === 1) return { name: defaults[0]! };
  return {
    name: null,
    error: `multiple profiles set default: true: ${defaults.join(", ")}`,
  };
}
