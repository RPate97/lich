import type { LifecycleList } from "../config/types.js";

// LICH_SKIP_BAKED=1: in-VM lich on a fork — drop hooks lacking per_fork: true.
export function filterBakedHooks(entries: LifecycleList, skipBaked: boolean): LifecycleList {
  if (!skipBaked) return entries;
  return entries.filter((e) => typeof e === "object" && e.per_fork === true);
}

export function shouldSkipBaked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LICH_SKIP_BAKED === "1";
}
