/**
 * Cycle detection for `profiles.<name>.extends` chains (Plan 3 Task 4).
 *
 * `profiles` form a directed graph where each profile may extend zero, one,
 * or many parent profiles (`extends: string | string[]`). The graph is
 * acyclic iff no DFS walk re-enters a node currently on its own active path.
 *
 * This module owns ONLY cycle detection — it does not check whether
 * `extends` references resolve to a declared profile (that's the resolver's
 * job in `profiles/resolve.ts`). We run cycle detection first because a
 * cycle would cause infinite recursion in the resolver.
 *
 * Unlike `groups/validate-extends.ts`, profiles have no built-in terminator
 * like the `stack` env_group; references that don't resolve to a declared
 * profile short-circuit (no cycle) and are reported by the resolver as
 * unresolved references.
 *
 * The two "extends cycle" detectors (this and `groups/validate-extends.ts`)
 * are structurally identical except for the input shape and `extends` arity.
 * Resist the urge to extract a shared helper — once Plan 3 ships there are
 * exactly two such detectors and the per-domain types add clarity.
 *
 * Pure function: no I/O, no async.
 */

import type { ProfileDef } from "../config/types.js";

/**
 * Detect a cycle in the `extends` graph of a `profiles` map.
 *
 * Returns `null` when the graph is acyclic (including the empty case).
 * Returns `{ cycle }` listing one example cycle when one exists, with the
 * starting node repeated at the end so the loop reads as a closed walk
 * (e.g. `["a", "b", "a"]`). This mirrors `deps/sort.ts`'s `CycleError.cycle`
 * shape and `groups/validate-extends.ts`'s output so downstream consumers
 * see a familiar format.
 *
 * Algorithm: classic three-color DFS.
 *
 *   - WHITE  = unvisited
 *   - GRAY   = on the active DFS path
 *   - BLACK  = fully explored, no cycle through it
 *
 * Entering a GRAY node closes a cycle. The active path slice from that node
 * to the current node IS the cycle; we return it with the start node
 * repeated at the end.
 *
 * `extends: "single"` and `extends: ["a", "b"]` are both supported; the
 * single-string form is normalized to a one-element array before walking.
 *
 * Iteration order over the entry-point set is sorted alphabetically for
 * deterministic output across runs.
 */
export function detectProfileExtendsCycle(
  profiles: Record<string, ProfileDef>,
): null | { cycle: string[] } {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const name of Object.keys(profiles)) color.set(name, WHITE);

  // Active path; mirrored by GRAY coloring for O(1) cycle-close detection.
  const path: string[] = [];

  for (const start of Object.keys(profiles).sort()) {
    if (color.get(start) !== WHITE) continue;
    const cycle = dfs(start);
    if (cycle) return { cycle };
  }
  return null;

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    path.push(node);

    const parents = normalizeExtends(profiles[node]?.extends);
    for (const parent of parents) {
      const parentColor = color.get(parent);
      if (parentColor === GRAY) {
        // Cycle closes at `parent` — slice from its position in `path` and
        // repeat it at the end for a visually closed walk.
        const idx = path.indexOf(parent);
        return [...path.slice(idx), parent];
      }
      // If `parent` is undeclared (color === undefined), it's a missing
      // reference — not our concern here; resolver will report it.
      if (parentColor === WHITE) {
        const found = dfs(parent);
        if (found) return found;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return null;
  }
}

/**
 * Normalize an `extends` field (string, string[], or undefined) to an array
 * of parent names. Returns `[]` when `extends` is undefined.
 */
function normalizeExtends(ext: string | string[] | undefined): string[] {
  if (ext === undefined) return [];
  return typeof ext === "string" ? [ext] : ext;
}
