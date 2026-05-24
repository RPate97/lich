/**
 * Cycle detection for `env_groups.<name>.extends` chains (Plan 2 Task 4).
 *
 * `env_groups` form a directed graph where each user-defined group has at
 * most one outgoing edge: its optional `extends` parent. The graph is acyclic
 * iff no DFS walk re-enters a node currently on its own active path.
 *
 * This module owns ONLY cycle detection — it does not check whether
 * `extends` references resolve to a declared group (that's the resolver's
 * job in `groups/resolve.ts`). We run cycle detection first because a cycle
 * would cause infinite recursion in the resolver.
 *
 * The built-in `stack` group is the only valid terminator that lives outside
 * `env_groups`; references to it are treated as leaves (the walk stops without
 * recursing). All other `extends` targets — whether declared in
 * `env_groups` or not — recurse if they're declared and short-circuit (no
 * cycle) if they're not. Reference-resolution errors are caught downstream.
 *
 * Pure function: no I/O, no async.
 */

import type { EnvGroupDef } from "../config/types.js";

/**
 * The built-in env_group name that always terminates an `extends` chain.
 * Defined here (not imported from `built-in-stack.ts`) to keep this module
 * dependency-free apart from types.
 */
const BUILT_IN_STACK = "stack";

/**
 * Detect a cycle in the `extends` graph of a user-defined `env_groups` map.
 *
 * Returns `null` when the graph is acyclic (including the empty case).
 * Returns `{ cycle }` listing one example cycle when one exists, with the
 * starting node repeated at the end so the loop reads as a closed walk
 * (e.g. `["a", "b", "a"]`). This mirrors `deps/sort.ts`'s `CycleError.cycle`
 * shape so downstream consumers see a familiar format.
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
 * Iteration order over the entry-point set is sorted alphabetically for
 * deterministic output across runs.
 */
export function detectExtendsCycle(
  groups: Record<string, EnvGroupDef>,
): null | { cycle: string[] } {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const name of Object.keys(groups)) color.set(name, WHITE);

  // Active path; mirrored by GRAY coloring for O(1) cycle-close detection.
  const path: string[] = [];

  for (const start of Object.keys(groups).sort()) {
    if (color.get(start) !== WHITE) continue;
    const cycle = dfs(start);
    if (cycle) return { cycle };
  }
  return null;

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    path.push(node);

    const parent = groups[node]?.extends;
    if (parent !== undefined && parent !== BUILT_IN_STACK) {
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
