/**
 * Cycle detection for `env_groups.<name>.extends` chains.
 *
 * Pure function: classic three-color DFS (WHITE = unvisited, GRAY = on path,
 * BLACK = explored). Entering a GRAY node closes a cycle. The built-in
 * `stack` group is a leaf terminator (the walk stops without recursing);
 * missing references short-circuit (resolver reports them).
 */

import type { EnvGroupDef } from "../config/types.js";

const BUILT_IN_STACK = "stack";

/**
 * Detect a cycle in the `extends` graph. Returns `null` if acyclic, otherwise
 * `{ cycle }` listing one example with the start node repeated at the end
 * (e.g. `["a", "b", "a"]`). Matches `deps/sort.ts`'s CycleError shape.
 * Entry-point order is sorted alphabetically for deterministic output.
 */
export function detectExtendsCycle(
  groups: Record<string, EnvGroupDef>,
): null | { cycle: string[] } {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const name of Object.keys(groups)) color.set(name, WHITE);

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
        // Cycle closes at `parent`; slice from its position and repeat at end.
        const idx = path.indexOf(parent);
        return [...path.slice(idx), parent];
      }
      // Undeclared parent (color === undefined) is a missing reference —
      // not our concern; resolver reports it.
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
