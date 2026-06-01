import type { LifecycleList } from "../config/types.js";

// LICH_SKIP_BAKED=1 means the in-VM lich is running on a sandbox fork — the
// baked setup is already in the disk image. Keep only hooks explicitly marked
// per_fork (the rare exception, e.g. registering an ephemeral URL). String-form
// shorthand entries have no per_fork field, so they're treated as baked and
// dropped.
export function filterBakedHooks(entries: LifecycleList, skipBaked: boolean): LifecycleList {
  if (!skipBaked) return entries;
  return entries.filter((e): boolean => typeof e === "object" && e !== null && e.per_fork === true);
}

export function shouldSkipBaked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LICH_SKIP_BAKED === "1";
}
