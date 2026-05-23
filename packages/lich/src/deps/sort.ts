/**
 * Topological sort over a dependency `Graph`.
 *
 * Uses Kahn's algorithm: at each round we collect the nodes whose remaining
 * unmet dependencies are zero — those nodes form one "level" that can be
 * started in parallel. Repeat until the graph is empty. If nodes remain at
 * the end, the unresolved subgraph contains a cycle; we reconstruct one
 * example cycle via DFS for the error message.
 *
 * Pure functions: no I/O, no async.
 */

import type { Graph } from "./graph.js";

/**
 * Thrown when the dependency graph contains a cycle (including self-loops).
 *
 * `cycle` lists one example cycle in traversal order, with the starting node
 * repeated at the end so the loop is visually closed
 * (e.g. `["a", "b", "c", "a"]`).
 */
export class CycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`cycle detected: ${cycle.join(" → ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

/**
 * Compute topological levels via Kahn's algorithm.
 *
 * All nodes in level N depend ONLY on nodes in levels 0..N-1. Within a level,
 * nodes can be started in parallel; the level itself is sorted alphabetically
 * for deterministic output.
 *
 * For shutdown order, iterate the levels in reverse (deepest level first).
 *
 * Throws `CycleError` if the graph has a cycle.
 */
export function topoLevels(g: Graph): string[][] {
  // remaining[name] = how many of name's dependencies are still unsatisfied
  const remaining = new Map<string, number>();
  for (const [name, deps] of g.edges) {
    remaining.set(name, deps.size);
  }

  // dependents[name] = nodes that depend ON name (reverse adjacency)
  const dependents = new Map<string, string[]>();
  for (const name of g.nodes.keys()) {
    dependents.set(name, []);
  }
  for (const [from, deps] of g.edges) {
    for (const target of deps) {
      // If target isn't declared, validateGraph should have caught it. We
      // tolerate it here by skipping — topoLevels is purely about ordering.
      const list = dependents.get(target);
      if (list) list.push(from);
    }
  }

  const levels: string[][] = [];
  let processed = 0;

  // Seed frontier with all nodes that have zero dependencies.
  let frontier: string[] = [];
  for (const [name, n] of remaining) {
    if (n === 0) frontier.push(name);
  }
  frontier.sort();

  while (frontier.length > 0) {
    levels.push(frontier);
    processed += frontier.length;

    const next: string[] = [];
    for (const name of frontier) {
      for (const dep of dependents.get(name) ?? []) {
        const r = (remaining.get(dep) ?? 0) - 1;
        remaining.set(dep, r);
        if (r === 0) next.push(dep);
      }
    }
    next.sort();
    frontier = next;
  }

  if (processed < g.nodes.size) {
    // Some nodes still have unmet dependencies — there's at least one cycle
    // among them. Find one example cycle via DFS.
    const stuck = new Set<string>();
    for (const [name, n] of remaining) {
      if (n > 0) stuck.add(name);
    }
    const cycle = findCycle(g, stuck);
    throw new CycleError(cycle);
  }

  return levels;
}

/**
 * Find one example cycle within `stuck` (the set of nodes that couldn't be
 * resolved by Kahn's). Returns the cycle as a list of node names with the
 * starting node repeated at the end.
 */
function findCycle(g: Graph, stuck: Set<string>): string[] {
  // DFS with a path stack; when we re-enter a node already on the path, we've
  // found a cycle. Iterate starting nodes in sorted order for determinism.
  const starts = [...stuck].sort();

  for (const start of starts) {
    const path: string[] = [];
    const onPath = new Set<string>();
    const visited = new Set<string>();

    const result = dfs(start);
    if (result) return result;

    function dfs(node: string): string[] | null {
      if (onPath.has(node)) {
        // close the cycle at the first occurrence of `node` in `path`
        const idx = path.indexOf(node);
        return [...path.slice(idx), node];
      }
      if (visited.has(node)) return null;

      visited.add(node);
      onPath.add(node);
      path.push(node);

      const deps = [...(g.edges.get(node) ?? [])]
        .filter((d) => stuck.has(d))
        .sort();
      for (const dep of deps) {
        const r = dfs(dep);
        if (r) return r;
      }

      path.pop();
      onPath.delete(node);
      return null;
    }
  }

  // Defensive fallback: shouldn't be reachable because Kahn's only leaves
  // stuck nodes when there is at least one cycle among them.
  return [...stuck].sort();
}

/**
 * Convenience: flat startup order (level-major, name-major within a level).
 *
 * Equivalent to `topoLevels(g).flat()`.
 */
export function startupOrder(g: Graph): string[] {
  return topoLevels(g).flat();
}

/** Convenience: shutdown order is the reverse of startup order. */
export function shutdownOrder(g: Graph): string[] {
  return startupOrder(g).reverse();
}
