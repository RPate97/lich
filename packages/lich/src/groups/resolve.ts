/**
 * `env_groups` resolver (Plan 2 Task 5).
 *
 * Resolves a named env_group into a fully-realized `KEY -> string` map,
 * walking the `extends` chain bottom-up and layering env sources per the
 * precedence rules in spec section 4. The built-in `"stack"` group is a
 * special case — it delegates to {@link resolveStackGroup} (the adapter
 * over Plan 1's top-level env pipeline).
 *
 * Precedence (later wins, per-key), matching the design spec section 4:
 *
 *   1. host `process.env`           (ONLY when the outermost group's
 *                                    `process_env !== false`. The outermost
 *                                    group owns the boundary policy; parent
 *                                    groups consumed via `extends` do NOT
 *                                    individually re-overlay process.env.
 *                                    The overlay happens at the bottom of
 *                                    the chain — either at the `stack` leaf
 *                                    via the adapter, or at the outermost
 *                                    group's own first layer when there's
 *                                    no `extends`.)
 *   2. parent group (recursive)     (if `extends` is declared; parent's full
 *                                    resolved env feeds in here)
 *   3. this group's `env_from`      (shell-out)
 *   4. this group's `env` literals  (coerced to strings)
 *
 * After merging, every value goes through {@link interpolateRecord} ONCE
 * at the outermost call against an {@link InterpolationContext} built from
 * the worktree info and the allocated-ports map. Recursive (parent) calls
 * do NOT interpolate — interpolating mid-walk would mean `${...}` refs in
 * parent env values get resolved against a parent-only context, then any
 * downstream `Object.assign` could re-introduce un-interpolated child values.
 * Resolving once at the top means all values see the same final context.
 *
 * NOTE: `env_files` is intentionally NOT supported on env_groups. The spec
 * is explicit: env_files belong to stack composition, not standalone groups.
 * Only `env_from`, `env`, `extends`, and `process_env` apply here.
 *
 * Cycle protection: {@link detectExtendsCycle} runs once at the outermost
 * call before any recursive walking. Validation normally catches cycles
 * earlier via `lich validate`, but this resolver guards against unvalidated
 * configs reaching it.
 */

import type { LichConfig, EnvMap } from "../config/types.js";
import {
  interpolateRecord,
  type InterpolationContext,
} from "../config/interpolation.js";
import type { Worktree } from "../worktree/detect.js";
import type { AllocatedPorts } from "../state/snapshot.js";
import { loadEnvFromShellOut } from "../env/shell-out.js";
import type { ResolvedProfile } from "../profiles/resolve.js";

import { resolveStackGroup } from "./built-in-stack.js";
import { detectExtendsCycle } from "./validate-extends.js";

// ---------------------------------------------------------------------------
// Public types & errors
// ---------------------------------------------------------------------------

export interface ResolveEnvGroupInput {
  /** Group name to resolve. `"stack"` delegates to the built-in adapter. */
  name: string;
  config: LichConfig;
  /** Resolved worktree info (provides ${worktree.*} refs + auto-injects via stack). */
  worktree: Worktree;
  /** Allocated ports — used to build the InterpolationContext. */
  allocatedPorts: AllocatedPorts;
  /** Project root cwd used for env_from cwd defaults. */
  projectRoot: string;
  /** Process env (defaults to `process.env` at call time if omitted). */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Plan-3 (LEV-454) active profile to layer into the built-in `stack` chain.
   * When provided AND the chain bottoms out at `stack`, the profile's
   * `env_from` / `env_files` / `env` are layered between top-level and
   * per-service (precedence steps 6-8 in `env/resolve.ts`'s docstring), and
   * `LICH_PROFILE` is auto-injected. User-defined groups themselves do NOT
   * consume this — env_groups are top-level by design and untouched by the
   * profile filter (LEV-388). The field only affects what the `stack`
   * terminator sees: it's threaded straight into `resolveStackGroup`'s
   * `profile` parameter when the recursive walker terminates there.
   *
   * Callers obtain `ResolvedProfile` from `profiles/resolve.ts`'s
   * `resolveProfile()`. The active profile is decided by `commands/up.ts`
   * at startup and persisted to `state.json` as `active_profile`; `lich exec`
   * and `lich env` re-resolve from the snapshot at command time.
   */
  profile?: ResolvedProfile;
}

/**
 * Thrown when {@link resolveEnvGroup} is asked to resolve a name that
 * isn't `"stack"` and isn't declared in `config.env_groups`. The message
 * includes a "did you mean" suggestion when a declared name is within
 * Levenshtein edit distance ~2 of the requested name.
 *
 * The requested group name is exposed as `requestedName` (NOT `name`)
 * because the inherited `Error.name` field is conventionally the class
 * name — overriding it with the user-supplied value would break the
 * widely-used `err.name === "GroupResolveError"` discriminator.
 */
export class GroupResolveError extends Error {
  /** The requested name that didn't resolve. */
  readonly requestedName: string;
  /** The suggested alternative, if any. */
  readonly suggestion: string | null;

  constructor(requestedName: string, suggestion: string | null) {
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    super(`env_group "${requestedName}" not declared${hint}`);
    this.name = "GroupResolveError";
    this.requestedName = requestedName;
    this.suggestion = suggestion;
  }
}

/**
 * Thrown when the `extends` graph contains a cycle. Validation normally
 * catches this earlier, but the resolver guards itself.
 */
export class GroupCycleError extends Error {
  /** The cycle as a closed walk (start node repeated at the end). */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`cycle in env_groups extends: ${cycle.join(" → ")}`);
    this.name = "GroupCycleError";
    this.cycle = cycle;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stringify EnvMap values. The schema allows string|number|boolean for
 * convenience; env vars are always strings at the OS level, so coerce
 * eagerly. Skip undefined entries defensively.
 *
 * Mirrors the equivalent helper in `env/resolve.ts` — duplicated rather
 * than imported to keep the dependency graph one-way (groups -> env, never
 * the other direction).
 */
function literalsToStrings(literals: EnvMap | undefined): Record<string, string> {
  if (!literals) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Copy process.env into a Record<string, string>. NodeJS.ProcessEnv allows
 * `undefined` values; drop those rather than carrying them through
 * (a key with value `undefined` would break interpolation downstream).
 */
function processEnvToRecord(pe: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(pe)) {
    const v = pe[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the InterpolationContext shape expected by interpolation.ts from
 * the worktree + allocated-ports inputs.
 *
 * Duplicated from `env/resolve.ts` for the same one-way-dependency reason
 * as {@link literalsToStrings}. The shapes must stay in sync; both are
 * pinned to {@link AllocatedPorts} so the type system catches drift.
 */
function buildInterpolationContext(
  worktree: Worktree,
  allocatedPorts: AllocatedPorts,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const [name, ports] of Object.entries(allocatedPorts.compose)) {
    const keys = Object.keys(ports);
    services[name] = {
      host_port: keys.length > 0 ? ports[keys[0]] : undefined,
    };
  }

  const owned: InterpolationContext["owned"] = {};
  for (const [name, entry] of Object.entries(allocatedPorts.owned)) {
    owned[name] = {
      port: entry.port,
      ports: entry.ports,
    };
  }

  return {
    worktree: {
      name: worktree.name,
      id: worktree.id,
      path: worktree.path,
    },
    services,
    owned,
  };
}

// ---------------------------------------------------------------------------
// "Did you mean" — small Levenshtein-based suggestion
// ---------------------------------------------------------------------------
// Duplicated inline (~30 LOC) from commands/validate.ts per the Plan 2 Task 5
// decision note: avoid cross-module reach for a small helper. Revisit when a
// third caller appears (extract to shared util at that point).

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
 * Internal recursive walker. Returns the merged env BEFORE interpolation.
 *
 * `processEnvAllowed` is decided ONCE at the outermost call (from the
 * outermost group's `process_env` policy, default `true`) and threaded
 * unchanged through every recursive parent call. This is the spec rule
 * pinned by the LEV-325 acceptance criteria: "process_env is honored at
 * the outermost call only when extends terminates — a group with
 * extends: stack and process_env: false should still NOT leak shell env."
 *
 * In practice this means:
 *   - Outermost group has process_env: true (default) → process.env IS
 *     overlaid wherever the chain bottoms out (at `stack` via the adapter,
 *     or at the outermost group's own first layer when no extends).
 *   - Outermost group has process_env: false → process.env is NEVER
 *     overlaid anywhere in this resolution, even if a parent group
 *     individually declares process_env: true. The outermost call owns
 *     the boundary; parent groups consumed via extends do not re-overlay.
 *
 * When the chain bottoms out at `stack`, we pass `processEnv: {}` to
 * suppress its built-in process.env baseline; otherwise we hand it the
 * caller's process.env.
 */
async function resolveInternal(
  name: string,
  ctx: {
    config: LichConfig;
    worktree: Worktree;
    allocatedPorts: AllocatedPorts;
    processEnv: NodeJS.ProcessEnv;
    projectRoot: string;
    /** Decided once at the outermost call; threaded unchanged downward. */
    processEnvAllowed: boolean;
    /**
     * Active profile (LEV-454). Only consumed when the recursive walker
     * terminates at the built-in `stack` adapter; threaded unchanged for
     * intermediate user-group hops. User-defined groups don't get a profile
     * layer of their own — they're top-level by design (LEV-388).
     */
    profile?: ResolvedProfile;
  },
): Promise<Record<string, string>> {
  // The built-in `stack` group is the universal terminator. It carries
  // its own process.env + auto-inject + top-level env logic. When the
  // outermost group blocks process_env passthrough, we suppress stack's
  // baseline by handing it an empty processEnv — stack's auto-injects
  // and top-level env layers still apply.
  if (name === "stack") {
    return resolveStackGroup({
      config: ctx.config,
      worktree: ctx.worktree,
      allocatedPorts: ctx.allocatedPorts,
      processEnv: ctx.processEnvAllowed ? ctx.processEnv : {},
      projectRoot: ctx.projectRoot,
      // LEV-454: thread the active profile into the stack terminator so its
      // env_from/env_files/env literals layer in, and LICH_PROFILE gets
      // auto-injected alongside LICH_WORKTREE / LICH_STACK_ID.
      profile: ctx.profile,
    });
  }

  const group = ctx.config.env_groups?.[name];
  if (!group) {
    // Reach here only via a parent reference (e.g. extends: "ghost") — the
    // outermost lookup is guarded in the public entry point. Treat as a
    // resolve failure with the same shape so callers get a consistent error.
    const declared = Object.keys(ctx.config.env_groups ?? {});
    throw new GroupResolveError(name, suggest(name, declared));
  }

  let merged: Record<string, string> = {};

  // Step 1: parent (recursive). The parent's resolution returns the fully-
  // layered parent env (which, if the chain bottoms out at stack, already
  // includes process.env or the empty suppression).
  if (group.extends !== undefined) {
    merged = await resolveInternal(group.extends, ctx);
  } else if (ctx.processEnvAllowed) {
    // No extends: this group is at the bottom of its own chain. Overlay
    // process.env here if the outermost policy permits.
    merged = processEnvToRecord(ctx.processEnv);
  }

  // Step 2: this group's env_from (shell-out). Pass the currently-merged
  // env so child commands see the parent + process_env layers laid down so
  // far (matches Plan 1's env/resolve.ts layering semantics).
  if (group.env_from && group.env_from.length > 0) {
    const fromShell = await loadEnvFromShellOut({
      entries: group.env_from,
      baseEnv: merged,
      defaultCwd: ctx.projectRoot,
    });
    Object.assign(merged, fromShell);
  }

  // Step 3: this group's env literals (coerced to strings; later wins).
  Object.assign(merged, literalsToStrings(group.env));

  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a named env_group to its full env map. See module-level doc for
 * precedence semantics, cycle protection, and the process_env / extends
 * interaction.
 *
 * Throws:
 *  - {@link GroupResolveError} if `name` is neither `"stack"` nor declared
 *    in `config.env_groups`.
 *  - {@link GroupCycleError} if the extends graph contains a cycle.
 *  - {@link InterpolationError} (re-thrown from `interpolateRecord`) when
 *    a `${...}` reference can't be resolved against the runtime context.
 *  - {@link ShellOutError} (re-thrown from `loadEnvFromShellOut`) when an
 *    env_from command fails or its output can't be parsed.
 */
export async function resolveEnvGroup(
  input: ResolveEnvGroupInput,
): Promise<Record<string, string>> {
  const processEnv = input.processEnv ?? process.env;

  // Outermost-name validation: built-in `stack` is always valid; user-named
  // groups must be declared. We check up-front so the failure message points
  // at the user-requested name (the recursive walker would otherwise blame
  // a parent reference indirection).
  if (input.name !== "stack") {
    const declared = Object.keys(input.config.env_groups ?? {});
    if (!declared.includes(input.name)) {
      throw new GroupResolveError(input.name, suggest(input.name, declared));
    }
  }

  // Cycle protection — runs once on the user-supplied groups map. The
  // detector treats the built-in `stack` as a terminator (matches the spec
  // and validate-extends's own contract).
  const groups = input.config.env_groups ?? {};
  const cycle = detectExtendsCycle(groups);
  if (cycle) {
    throw new GroupCycleError(cycle.cycle);
  }

  // Determine process_env policy from the outermost group ONCE here and
  // thread it unchanged through recursion. The built-in `stack` defaults
  // to allowing process.env (it has no `process_env: false` opt-out).
  const outermostGroup =
    input.name === "stack" ? undefined : input.config.env_groups?.[input.name];
  const processEnvAllowed = outermostGroup?.process_env !== false; // default true

  const merged = await resolveInternal(input.name, {
    config: input.config,
    worktree: input.worktree,
    allocatedPorts: input.allocatedPorts,
    processEnv,
    projectRoot: input.projectRoot,
    processEnvAllowed,
    profile: input.profile,
  });

  // Final pass: interpolate every value once against the runtime context.
  // Done at the outermost call so all values see the same merged-and-final
  // env map; mid-walk interpolation would produce stale results if a child
  // overwrites a parent value with a different `${...}` reference.
  const interpolationCtx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
  );
  return interpolateRecord(merged, interpolationCtx, `group:${input.name}`);
}
