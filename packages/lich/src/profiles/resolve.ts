/**
 * Profile resolver (Plan 3 Task 5).
 *
 * Walks a profile's `extends` chain and computes a fully-realized
 * {@link ResolvedProfile}: the union of services + owned across the chain,
 * the layered env bundle, and the composed lifecycle hooks. Pure logic; no
 * I/O, no async.
 *
 * Resolution model
 * ----------------
 * A profile is defined as:
 *
 *   profileName:
 *     extends: <name> | [<name>, ...]   # optional
 *     services: [...]                   # compose names
 *     owned: [...]                      # owned names
 *     env: { ... }                      # literal env map
 *     env_files: [ ... ]                # dotenv file paths
 *     env_from: [ ... ]                 # shell-out entries
 *     lifecycle:                        # top-level shape (before_up etc.)
 *       before_up: [ ... ]
 *       after_up: [ ... ]
 *       before_down: [ ... ]
 *
 * The resolver folds these in a deterministic order:
 *
 *   1. Walk `extends` parents in declared order. For each parent name,
 *      recursively `resolve(parent)` (memoized) and layer its values into the
 *      accumulator. Multiple parents in array form layer in the declared
 *      order — parent[1]'s values overlay parent[0]'s; the child overlays
 *      both at the end.
 *   2. Layer this profile's own values on top.
 *
 * Per-field semantics
 * -------------------
 *
 *   - `services`, `owned`: union-deduplicated, parents-first then child.
 *     Order is load-bearing for reproducibility: tests pin the exact slice.
 *     Plan 1's startup uses this order to seed the dep graph; the dep graph
 *     then computes its own topo order, so input order only affects ties —
 *     but reproducibility matters for assertions.
 *   - `env`: per-key layering. Later-declared parents override earlier ones;
 *     the child overrides any parent. Stored as the union (parent keys not
 *     overridden by the child survive into the result).
 *   - `env_files`, `env_from`: ordered concatenation. Parents first (in
 *     declared order), then child. Caller decides any further precedence —
 *     this resolver preserves the structural concat the spec describes.
 *   - `lifecycle.before_up` / `lifecycle.after_up`: parents first (in
 *     declared order), then child. Specialization runs AFTER the base setup
 *     finishes.
 *   - `lifecycle.before_down`: LIFO — child first, then parents (in declared
 *     order — the FIRST parent's tear-down runs LAST). Undo the most-specific
 *     specialization before tearing down the base.
 *
 * Cycle protection
 * ----------------
 * {@link detectProfileExtendsCycle} runs once at the top of the public entry
 * point as a safety net. Validation normally catches cycles earlier via
 * `lich validate` (Plan 3 Task 10), but the resolver guards against
 * unvalidated configs reaching it — infinite recursion is the alternative.
 *
 * Memoization
 * -----------
 * Within a single `resolveProfile` call we memoize sub-resolutions by name
 * (`Map<string, ResolvedProfile>`). This makes diamond inheritance cheap:
 * `child extends [a, b]; a extends root; b extends root` resolves `root`
 * exactly once. Memoization is per-call (not module-level) so config edits
 * between calls always re-resolve from scratch.
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

// ---------------------------------------------------------------------------
// Public types & errors
// ---------------------------------------------------------------------------

/**
 * The fully-realized output of {@link resolveProfile}. Carries the union of
 * services + owned across the requested profile's `extends` chain, the
 * layered env bundle, and the composed lifecycle.
 *
 * Consumers (Plan 3 Task 6 onwards: `env/resolve.ts`, `commands/up.ts`,
 * `commands/down.ts`) read these fields directly — `ResolvedProfile` is
 * structurally compatible with `Pick<LichConfig, "env" | "env_files" |
 * "env_from">` for `env/resolve.ts`'s `layerBundle` consumption.
 *
 * Both `services` and `owned` are guaranteed non-undefined (empty arrays when
 * no profile in the chain declares either). Same for `env`, `env_files`,
 * `env_from`, and `lifecycle`'s phase arrays — callers can iterate without
 * undefined-guards.
 */
export interface ResolvedProfile {
  /** The requested name (what the caller passed to {@link resolveProfile}). */
  name: string;
  /**
   * Union of every parent's + this profile's `services`, in declared order,
   * deduplicated; parents come first. Empty array when nothing in the chain
   * declares services.
   */
  services: string[];
  /** Same union semantics as {@link services}. */
  owned: string[];
  /**
   * Per-key merge of every layer's `env`. Later layers override earlier
   * ones: parents (in declared order) → child. Empty object when nothing
   * in the chain declares env.
   */
  env: EnvMap;
  /**
   * Ordered concatenation of every layer's `env_files`. Parents first (in
   * declared order), then child. Empty array when nothing declares files.
   */
  env_files: EnvFiles;
  /**
   * Ordered concatenation of every layer's `env_from`. Parents first (in
   * declared order), then child. Empty array when nothing declares from.
   */
  env_from: EnvFrom;
  /**
   * Per-phase composed lifecycle. `before_up` / `after_up` run parents first
   * then child; `before_down` runs child first then parents (LIFO).
   *
   * Each phase is always an array — empty arrays when nothing in the chain
   * declared the phase. The shape mirrors `TopLevelLifecycle` for direct
   * passthrough to the lifecycle executor.
   */
  lifecycle: Required<TopLevelLifecycle>;
}

/**
 * Thrown when {@link resolveProfile} is asked to resolve a name that isn't
 * declared in `config.profiles`. The message includes a "did you mean"
 * suggestion when a declared profile is within Levenshtein edit distance ~2
 * of the requested name.
 *
 * The requested profile name is exposed as `requestedName` (NOT `name`)
 * because the inherited `Error.name` field is conventionally the class
 * name — overriding it with the user-supplied value would break the widely-
 * used `err.name === "ProfileResolveError"` discriminator.
 */
export class ProfileResolveError extends Error {
  /** The requested name that didn't resolve. */
  readonly requestedName: string;
  /** The suggested alternative, if any. */
  readonly suggestion: string | null;

  constructor(requestedName: string, suggestion: string | null) {
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    super(`profile "${requestedName}" not declared${hint}`);
    this.name = "ProfileResolveError";
    this.requestedName = requestedName;
    this.suggestion = suggestion;
  }
}

/**
 * Thrown when the `extends` graph contains a cycle. Validation normally
 * catches this earlier (`lich validate` — Plan 3 Task 10), but the resolver
 * guards against unvalidated configs reaching it. Shape mirrors
 * `GroupCycleError` and `deps/sort.ts`'s `CycleError`.
 */
export class ProfileCycleError extends Error {
  /** The cycle as a closed walk (start node repeated at the end). */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`cycle in profiles extends: ${cycle.join(" → ")}`);
    this.name = "ProfileCycleError";
    this.cycle = cycle;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an `extends` field (string, string[], or undefined) to an array
 * of parent names. Returns `[]` when `extends` is undefined.
 */
function normalizeExtends(ext: string | string[] | undefined): string[] {
  if (ext === undefined) return [];
  return typeof ext === "string" ? [ext] : ext;
}

/**
 * Append items from `src` to `dst` while skipping any name already present.
 * Mutates `dst` for efficiency in the resolver's tight inner loop; the
 * resolver only ever mutates buffers it owns.
 */
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

// ---------------------------------------------------------------------------
// "Did you mean" — small Levenshtein-based suggestion
// ---------------------------------------------------------------------------
// Duplicated inline (~25 LOC) per the Plan 3 Task 5 decision note: avoid
// cross-module reach for a small helper. The same helper exists in
// `commands/validate.ts`, `commands/help.ts`, and `groups/resolve.ts`.
// Extracting after the fourth copy is the right move; that's Plan 6 cleanup.

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
  // Only suggest if the edit distance is small relative to the input.
  // Matches the threshold used by `commands/validate.ts` and `groups/resolve.ts`.
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

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Internal recursive walker. Returns a {@link ResolvedProfile} for `name`,
 * memoized in `memo`. Assumes cycle detection has already run and the name
 * exists in `profiles` (the public entry point guarantees both).
 *
 * For each profile we:
 *
 *   1. Resolve every parent in declared order, accumulating their
 *      ResolvedProfile slices.
 *   2. Concatenate the parent slices into our own buffers (parents-first
 *      order: parent[0] first, then parent[1], ...).
 *   3. Layer this profile's own values on top.
 *
 * `before_down` reverses the layering for the per-phase composition: child
 * first, then parents (in declared order — so parent[0]'s entries run LAST).
 */
function resolveInternal(
  name: string,
  profiles: Record<string, ProfileDef>,
  memo: Map<string, ResolvedProfile>,
): ResolvedProfile {
  const cached = memo.get(name);
  if (cached) return cached;

  const def = profiles[name];
  // The public entry point guarantees the outermost name exists; recursive
  // descents reach here only via a parent reference. A missing parent at
  // this level is an unresolved-reference error from the caller's POV.
  if (!def) {
    const declared = Object.keys(profiles);
    throw new ProfileResolveError(name, suggest(name, declared));
  }

  // Resolve parents in declared order. The memo collapses diamonds so a
  // shared ancestor is realized once.
  const parents = normalizeExtends(def.extends).map((parentName) =>
    resolveInternal(parentName, profiles, memo),
  );

  // Accumulate. Buffers start empty; parents flow in first, then the child.
  const services: string[] = [];
  const owned: string[] = [];
  const env: EnvMap = {};
  const env_files: EnvFiles = [];
  const env_from: EnvFrom = [];
  const before_up: LifecycleList = [];
  const after_up: LifecycleList = [];
  const before_down: LifecycleList = [];

  // Step 1: parents in declared order — parent[0] is the outermost layer
  // (most-overridden), parent[N-1] is the innermost (almost won by child).
  for (const parent of parents) {
    appendDeduped(services, parent.services);
    appendDeduped(owned, parent.owned);
    Object.assign(env, parent.env);
    env_files.push(...parent.env_files);
    env_from.push(...parent.env_from);
    before_up.push(...parent.lifecycle.before_up);
    after_up.push(...parent.lifecycle.after_up);
    // before_down accumulates parents in declared order TOO at this stage;
    // we'll prepend the child's before_down after this loop so the final
    // order is [child, parent[0], parent[1], ...].
    before_down.push(...parent.lifecycle.before_down);
  }

  // Step 2: this profile's own values, layered last.
  appendDeduped(services, def.services);
  appendDeduped(owned, def.owned);
  if (def.env) Object.assign(env, def.env);
  if (def.env_files) env_files.push(...def.env_files);
  if (def.env_from) env_from.push(...def.env_from);
  if (def.lifecycle?.before_up) before_up.push(...def.lifecycle.before_up);
  if (def.lifecycle?.after_up) after_up.push(...def.lifecycle.after_up);
  if (def.lifecycle?.before_down) {
    // LIFO: child's tear-down runs FIRST (undo specialization before
    // tearing down the base). Prepend to the parents-in-declared-order
    // buffer we built in Step 1.
    before_down.unshift(...def.lifecycle.before_down);
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
    },
  };
  memo.set(name, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a named profile to a fully-realized {@link ResolvedProfile}. See
 * module-level doc for layering semantics and per-field rules.
 *
 * Throws:
 *  - {@link ProfileResolveError} if `name` is not declared in
 *    `config.profiles` (or if an `extends` reference encountered during
 *    recursion resolves to an undeclared parent).
 *  - {@link ProfileCycleError} if the `extends` graph contains a cycle.
 */
export function resolveProfile(
  name: string,
  config: LichConfig,
): ResolvedProfile {
  const profiles = config.profiles ?? {};

  // Outermost-name validation: declared profile names form the suggestion
  // pool. We check up-front so the error blames the user-requested name (the
  // recursive walker would otherwise indirect via a parent reference if the
  // outermost name slipped through).
  if (!profiles[name]) {
    const declared = Object.keys(profiles);
    throw new ProfileResolveError(name, suggest(name, declared));
  }

  // Cycle protection — runs once on the user-supplied profiles map. The
  // detector treats undeclared parent references as leaves (no cycle); the
  // recursive walker will surface those as ProfileResolveError if reached.
  const cycle = detectProfileExtendsCycle(profiles);
  if (cycle) {
    throw new ProfileCycleError(cycle.cycle);
  }

  // Memo is per-call: a single resolveProfile invocation realizes a shared
  // ancestor (diamond inheritance) exactly once. Module-level memoization
  // would cache stale results across config edits.
  const memo = new Map<string, ResolvedProfile>();
  return resolveInternal(name, profiles, memo);
}
