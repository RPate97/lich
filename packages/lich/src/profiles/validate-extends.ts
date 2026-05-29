import type { ProfileDef } from "../config/types.js";

/**
 * Cycle-detect the `profiles.<name>.extends` graph via three-color DFS.
 * Returns `null` if acyclic, else `{ cycle }` listing one example cycle
 * with the start node repeated at the end (e.g. `["a", "b", "a"]`).
 *
 * Undeclared parent references are ignored — the resolver reports them.
 */
export function detectProfileExtendsCycle(
  profiles: Record<string, ProfileDef>,
): null | { cycle: string[] } {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  for (const name of Object.keys(profiles)) color.set(name, WHITE);

  const path: string[] = [];

  // sorted iteration for deterministic output
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
        const idx = path.indexOf(parent);
        return [...path.slice(idx), parent];
      }
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

function normalizeExtends(ext: string | string[] | undefined): string[] {
  if (ext === undefined) return [];
  return typeof ext === "string" ? [ext] : ext;
}
