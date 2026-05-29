/**
 * Topological sort via Kahn's algorithm. Nodes whose remaining unmet
 * dependencies are zero form one "level" startable in parallel. Repeat until
 * empty; remaining nodes contain a cycle (reconstructed via DFS for the error).
 */

import type { Graph } from "./graph.js";

/**
 * Thrown when the dependency graph contains a cycle (including self-loops).
 * `cycle` lists one example with the start node repeated at the end
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
 * Compute topological levels. All nodes in level N depend only on levels
 * 0..N-1. Within a level, nodes can start in parallel; sorted alphabetically
 * for deterministic output. For shutdown, iterate levels in reverse.
 *
 * Throws `CycleError` if the graph has a cycle.
 */
export function topoLevels(g: Graph): string[][] {
  const remaining = new Map<string, number>();
  for (const [name, deps] of g.edges) {
    remaining.set(name, deps.size);
  }

  // reverse adjacency: dependents[name] = nodes that depend ON name
  const dependents = new Map<string, string[]>();
  for (const name of g.nodes.keys()) {
    dependents.set(name, []);
  }
  for (const [from, deps] of g.edges) {
    for (const target of deps) {
      // undeclared targets should have been caught by validateGraph; skip
      const list = dependents.get(target);
      if (list) list.push(from);
    }
  }

  const levels: string[][] = [];
  let processed = 0;

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
    const stuck = new Set<string>();
    for (const [name, n] of remaining) {
      if (n > 0) stuck.add(name);
    }
    const cycle = findCycle(g, stuck);
    throw new CycleError(cycle);
  }

  return levels;
}

/** Find one example cycle within `stuck` via DFS; start node repeated at end. */
function findCycle(g: Graph, stuck: Set<string>): string[] {
  const starts = [...stuck].sort();

  for (const start of starts) {
    const path: string[] = [];
    const onPath = new Set<string>();
    const visited = new Set<string>();

    const result = dfs(start);
    if (result) return result;

    function dfs(node: string): string[] | null {
      if (onPath.has(node)) {
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

  // Defensive fallback: Kahn's only leaves stuck nodes when a cycle exists.
  return [...stuck].sort();
}

/** Flat startup order (level-major, name-major within a level). */
export function startupOrder(g: Graph): string[] {
  return topoLevels(g).flat();
}

/** Shutdown order is the reverse of startup order. */
export function shutdownOrder(g: Graph): string[] {
  return startupOrder(g).reverse();
}
