/**
 * Profile resolver. Walks a profile's `extends` chain and computes a fully-
 * realized {@link ResolvedProfile}. Pure; no I/O.
 *
 * Merge semantics:
 *   - `services`, `owned`: union-deduplicated, parents-first (in declared
 *     order) then child. Order is load-bearing for reproducibility.
 *   - `env`: per-key layering, later layers override; child wins.
 *   - `env_files`, `env_from`: ordered concat, parents (declared order) then child.
 *   - `lifecycle.{before,after}_up`: parents (declared order) then child —
 *     specialization runs AFTER base setup.
 *   - `lifecycle.{before,after}_down`: LIFO — child first, then parents
 *     (declared order, so parent[0] runs LAST). Undo the most-specific
 *     layer before tearing down the base.
 *
 * Memoization is per-call so config edits between calls re-resolve fresh.
 */

import type {
  EnvFiles,
  EnvFrom,
  EnvMap,
  LichConfig,
  LifecycleList,
  ProfileDef,
  TopLevelLifecycle,
} from "../config/types.js";

import { detectProfileExtendsCycle } from "./validate-extends.js";

/**
 * Fully-realized output of {@link resolveProfile}. All array/map fields
 * are non-undefined (empty when nothing in the chain declared them) so
 * callers iterate without guards.
 */
export interface ResolvedProfile {
  name: string;
  services: string[];
  owned: string[];
  env: EnvMap;
  env_files: EnvFiles;
  env_from: EnvFrom;
  lifecycle: Required<TopLevelLifecycle>;
}

/**
 * Thrown when {@link resolveProfile} can't find a name in `config.profiles`.
 * The user-supplied name is on `requestedName`, not `name`, so the
 * `err.name === "ProfileResolveError"` discriminator keeps working.
 */
export class ProfileResolveError extends Error {
  readonly requestedName: string;
  readonly suggestion: string | null;

  constructor(requestedName: string, suggestion: string | null) {
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    super(`profile "${requestedName}" not declared${hint}`);
    this.name = "ProfileResolveError";
    this.requestedName = requestedName;
    this.suggestion = suggestion;
  }
}

/** Thrown when the `extends` graph contains a cycle. Validation usually catches this first. */
export class ProfileCycleError extends Error {
  /** The cycle as a closed walk (start node repeated at the end). */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`cycle in profiles extends: ${cycle.join(" → ")}`);
    this.name = "ProfileCycleError";
    this.cycle = cycle;
  }
}

function normalizeExtends(ext: string | string[] | undefined): string[] {
  if (ext === undefined) return [];
  return typeof ext === "string" ? [ext] : ext;
}

function appendDeduped(dst: string[], src: readonly string[] | undefined): void {
  if (!src) return;
  const seen = new Set(dst);
  for (const name of src) {
    if (!seen.has(name)) {
      dst.push(name);
      seen.add(name);
    }
  }
}

// duplicated in commands/validate.ts, commands/help.ts, groups/resolve.ts
function suggest(needle: string, haystack: string[]): string | null {
  if (haystack.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of haystack) {
    const d = levenshtein(needle, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  const threshold = Math.max(1, Math.floor(needle.length / 3));
  if (best && bestDist <= threshold) return best;
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function resolveInternal(
  name: string,
  profiles: Record<string, ProfileDef>,
  memo: Map<string, ResolvedProfile>,
): ResolvedProfile {
  const cached = memo.get(name);
  if (cached) return cached;

  const def = profiles[name];
  if (!def) {
    // reached via an extends reference to an undeclared parent
    const declared = Object.keys(profiles);
    throw new ProfileResolveError(name, suggest(name, declared));
  }

  const parents = normalizeExtends(def.extends).map((parentName) =>
    resolveInternal(parentName, profiles, memo),
  );

  const services: string[] = [];
  const owned: string[] = [];
  const env: EnvMap = {};
  const env_files: EnvFiles = [];
  const env_from: EnvFrom = [];
  const before_up: LifecycleList = [];
  const after_up: LifecycleList = [];
  const before_down: LifecycleList = [];
  const after_down: LifecycleList = [];

  // parents in declared order: parent[0] is the most-overridden layer
  for (const parent of parents) {
    appendDeduped(services, parent.services);
    appendDeduped(owned, parent.owned);
    Object.assign(env, parent.env);
    env_files.push(...parent.env_files);
    env_from.push(...parent.env_from);
    before_up.push(...parent.lifecycle.before_up);
    after_up.push(...parent.lifecycle.after_up);
    before_down.push(...parent.lifecycle.before_down);
    after_down.push(...parent.lifecycle.after_down);
  }

  // child layered last
  appendDeduped(services, def.services);
  appendDeduped(owned, def.owned);
  if (def.env) Object.assign(env, def.env);
  if (def.env_files) env_files.push(...def.env_files);
  if (def.env_from) env_from.push(...def.env_from);
  if (def.lifecycle?.before_up) before_up.push(...def.lifecycle.before_up);
  if (def.lifecycle?.after_up) after_up.push(...def.lifecycle.after_up);
  // LIFO for down phases: child runs first → prepend to the parents buffer
  if (def.lifecycle?.before_down) {
    before_down.unshift(...def.lifecycle.before_down);
  }
  if (def.lifecycle?.after_down) {
    after_down.unshift(...def.lifecycle.after_down);
  }

  const resolved: ResolvedProfile = {
    name,
    services,
    owned,
    env,
    env_files,
    env_from,
    lifecycle: {
      before_up,
      after_up,
      before_down,
      after_down,
    },
  };
  memo.set(name, resolved);
  return resolved;
}

/**
 * Resolve a named profile to a {@link ResolvedProfile}.
 * Throws {@link ProfileResolveError} for missing names (including
 * undeclared parents reached via `extends`) and {@link ProfileCycleError}
 * for cycles in the `extends` graph.
 */
export function resolveProfile(
  name: string,
  config: LichConfig,
): ResolvedProfile {
  const profiles = config.profiles ?? {};

  // up-front check so the error blames the user-supplied name, not a parent
  if (!profiles[name]) {
    const declared = Object.keys(profiles);
    throw new ProfileResolveError(name, suggest(name, declared));
  }

  const cycle = detectProfileExtendsCycle(profiles);
  if (cycle) {
    throw new ProfileCycleError(cycle.cycle);
  }

  const memo = new Map<string, ResolvedProfile>();
  return resolveInternal(name, profiles, memo);
}
