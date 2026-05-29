/**
 * `env_groups` resolver. Walks the `extends` chain bottom-up and layers env
 * sources. The built-in `"stack"` group delegates to `resolveStackGroup`.
 *
 * Precedence (later wins, per-key):
 *
 *   1. host `process.env` — ONLY when the outermost group's `process_env !== false`.
 *      The outermost group owns the boundary; parent groups consumed via
 *      `extends` do NOT individually re-overlay process.env. Overlay happens
 *      at the bottom of the chain (at `stack` via the adapter, or at the
 *      outermost group's own first layer when there's no `extends`).
 *   2. parent group (recursive)
 *   3. this group's `env_from` (shell-out)
 *   4. this group's `env` literals
 *
 * Interpolation runs ONCE at the outermost call against an InterpolationContext
 * built from worktree + ports. Mid-walk interpolation would mean parent
 * `${...}` refs resolve against a parent-only context, then downstream
 * Object.assign could re-introduce un-interpolated child values.
 *
 * `env_files` is intentionally NOT supported on env_groups — it belongs to
 * stack composition, not standalone groups.
 *
 * Cycle protection runs once at the outermost call before any recursion.
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

export interface ResolveEnvGroupInput {
  /** Group name. `"stack"` delegates to the built-in adapter. */
  name: string;
  config: LichConfig;
  worktree: Worktree;
  allocatedPorts: AllocatedPorts;
  /** Project root for env_from cwd defaults. */
  projectRoot: string;
  /** Process env (defaults to `process.env`). */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Active profile to layer into the built-in `stack` chain. Only consumed
   * when the chain bottoms out at `stack`. User-defined env_groups are
   * top-level by design and untouched by the profile filter.
   */
  profile?: ResolvedProfile;
}

/**
 * Thrown when the requested name isn't `"stack"` and isn't in `config.env_groups`.
 * Includes a "did you mean" suggestion. `requestedName` (not `name`) is used
 * because `Error.name` is conventionally the class name.
 */
export class GroupResolveError extends Error {
  readonly requestedName: string;
  readonly suggestion: string | null;

  constructor(requestedName: string, suggestion: string | null) {
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    super(`env_group "${requestedName}" not declared${hint}`);
    this.name = "GroupResolveError";
    this.requestedName = requestedName;
    this.suggestion = suggestion;
  }
}

/** Thrown when the `extends` graph contains a cycle. */
export class GroupCycleError extends Error {
  /** The cycle as a closed walk (start node repeated at the end). */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`cycle in env_groups extends: ${cycle.join(" → ")}`);
    this.name = "GroupCycleError";
    this.cycle = cycle;
  }
}

/**
 * Coerce EnvMap values to `string | null`. Strings pass; numbers/booleans
 * stringify; `null` survives as the unset sentinel (dropped at the end).
 * Duplicated from `env/resolve.ts` rather than imported to keep the
 * dependency one-way (groups -> env).
 */
function literalsToStrings(
  literals: EnvMap | undefined,
): Record<string, string | null> {
  if (!literals) return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
      continue;
    }
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Drop keys whose final value is `null`. Tracked through layering so
 * "later wins per key" still picks it up (an outer group's literal `null`
 * beats a parent group's string), then deleted at the very end before
 * interpolation.
 */
function dropNullValues(
  merged: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Copy process.env into `Record<string, string | null>`; drop undefined values. */
function processEnvToRecord(
  pe: NodeJS.ProcessEnv,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(pe)) {
    const v = pe[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build the InterpolationContext from worktree + allocated ports. Duplicated
 * from `env/resolve.ts` for the same one-way-dependency reason; shapes must
 * stay in sync — both pinned to `AllocatedPorts`.
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
      ports: { ...ports },
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

// Inlined Levenshtein-based suggestion. Duplicated from commands/validate.ts;
// extract to a shared util when a third caller appears.

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

/**
 * Internal recursive walker. Returns the merged env BEFORE interpolation.
 *
 * `processEnvAllowed` is decided ONCE at the outermost call and threaded
 * unchanged through recursion. Outermost `process_env: false` blocks
 * process.env overlay anywhere in the chain, even if a parent group
 * individually declares `process_env: true`.
 *
 * When the chain bottoms out at `stack`, pass `processEnv: {}` to suppress
 * stack's built-in process.env baseline.
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
     * Active profile. Only consumed when the walker terminates at `stack`;
     * threaded unchanged through intermediate user-group hops. User groups
     * don't get a profile layer of their own.
     */
    profile?: ResolvedProfile;
  },
): Promise<Record<string, string | null>> {
  // `stack` is the universal terminator with its own process.env + auto-inject
  // + top-level env logic. When the outermost group blocks process_env
  // passthrough, suppress stack's baseline with an empty processEnv —
  // auto-injects and top-level env layers still apply.
  //
  // resolveStackGroup returns `Record<string, string>` after its own null-drop.
  // That's fine: an outer user-group can still layer `env: { FOO: null }` on
  // top (Object.assign widens the value type), and the null gets dropped at
  // the end of this group's resolution.
  if (name === "stack") {
    return resolveStackGroup({
      config: ctx.config,
      worktree: ctx.worktree,
      allocatedPorts: ctx.allocatedPorts,
      processEnv: ctx.processEnvAllowed ? ctx.processEnv : {},
      projectRoot: ctx.projectRoot,
      profile: ctx.profile,
    });
  }

  const group = ctx.config.env_groups?.[name];
  if (!group) {
    // Reach here only via a parent reference; outermost lookup is guarded
    // in the public entry point.
    const declared = Object.keys(ctx.config.env_groups ?? {});
    throw new GroupResolveError(name, suggest(name, declared));
  }

  // Carried through as `string | null` so layered `env: { FOO: null }`
  // markers survive Object.assign until the outermost call drops them.
  let merged: Record<string, string | null> = {};

  if (group.extends !== undefined) {
    merged = await resolveInternal(group.extends, ctx);
  } else if (ctx.processEnvAllowed) {
    // No extends: bottom of the chain. Overlay process.env here.
    merged = processEnvToRecord(ctx.processEnv);
  }

  // env_from: pass current merged env so the cmd sees parent + process_env.
  // Strip null markers — Node's spawn stringifies `null` to `"null"`.
  if (group.env_from && group.env_from.length > 0) {
    const fromShell = await loadEnvFromShellOut({
      entries: group.env_from,
      baseEnv: dropNullValues(merged),
      defaultCwd: ctx.projectRoot,
    });
    Object.assign(merged, fromShell);
  }

  Object.assign(merged, literalsToStrings(group.env));

  return merged;
}

/**
 * Resolve a named env_group to its full env map. Throws:
 *  - `GroupResolveError` if `name` is neither `"stack"` nor declared.
 *  - `GroupCycleError` if the extends graph cycles.
 *  - `InterpolationError` on `${...}` resolution failure.
 *  - `ShellOutError` on env_from command/parse failure.
 */
export async function resolveEnvGroup(
  input: ResolveEnvGroupInput,
): Promise<Record<string, string>> {
  const processEnv = input.processEnv ?? process.env;

  // Validate outermost name up-front so the error points at the user-requested
  // name rather than a parent reference indirection.
  if (input.name !== "stack") {
    const declared = Object.keys(input.config.env_groups ?? {});
    if (!declared.includes(input.name)) {
      throw new GroupResolveError(input.name, suggest(input.name, declared));
    }
  }

  const groups = input.config.env_groups ?? {};
  const cycle = detectExtendsCycle(groups);
  if (cycle) {
    throw new GroupCycleError(cycle.cycle);
  }

  // process_env policy decided ONCE here and threaded through recursion.
  // Built-in `stack` defaults to allowing process.env.
  const outermostGroup =
    input.name === "stack" ? undefined : input.config.env_groups?.[input.name];
  const processEnvAllowed = outermostGroup?.process_env !== false;

  const merged = await resolveInternal(input.name, {
    config: input.config,
    worktree: input.worktree,
    allocatedPorts: input.allocatedPorts,
    processEnv,
    projectRoot: input.projectRoot,
    processEnvAllowed,
    profile: input.profile,
  });

  const finalEnv = dropNullValues(merged);

  // Interpolate once at the outermost call so all values see the same
  // merged-and-final env map.
  const interpolationCtx = buildInterpolationContext(
    input.worktree,
    input.allocatedPorts,
  );
  return interpolateRecord(finalEnv, interpolationCtx, `group:${input.name}`);
}
