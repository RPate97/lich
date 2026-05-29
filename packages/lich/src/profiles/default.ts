import type { LichConfig } from "../config/types.js";

/**
 * Pick the single profile flagged `default: true`. Returns `{ name: null }`
 * if none is flagged (callers decide whether that's an error), or
 * `{ name: null, error }` when multiple profiles claim the default.
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
