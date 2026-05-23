/**
 * Dependency graph over services (compose) + owned processes.
 *
 * Pure data structures and validation. No I/O, no async. Cross-kind edges are
 * permitted: an owned process may depend on a compose service and vice versa.
 */

export type ServiceKind = "compose" | "owned";

export interface NodeDecl {
  name: string;
  kind: ServiceKind;
  /** Names of other nodes (compose or owned) this depends on. */
  depends_on: string[];
}

export interface Graph {
  /** name -> declaration */
  nodes: ReadonlyMap<string, NodeDecl>;
  /** name -> set of dependency names */
  edges: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Build a graph from arrays of service + owned declarations.
 *
 * Cross-kind edges allowed: owned can depend on compose and vice versa.
 * Duplicate dependency entries are deduplicated. Self-references are kept
 * (and surfaced later as cycles by topological sort).
 */
export function buildGraph(decls: NodeDecl[]): Graph {
  const nodes = new Map<string, NodeDecl>();
  const edges = new Map<string, ReadonlySet<string>>();

  for (const decl of decls) {
    if (nodes.has(decl.name)) {
      throw new Error(`duplicate node declaration: ${decl.name}`);
    }
    nodes.set(decl.name, decl);
    edges.set(decl.name, new Set(decl.depends_on));
  }

  return { nodes, edges };
}

/** A missing dependency target — a node references a name that isn't declared. */
export interface MissingDep {
  from: string;
  target: string;
}

/**
 * Thrown when `validateGraph` finds dependency edges pointing at undeclared
 * nodes. Lists every offender, not just the first, so the user can fix them
 * all in one pass.
 */
export class DependencyError extends Error {
  readonly missing: MissingDep[];

  constructor(missing: MissingDep[]) {
    const sorted = [...missing].sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
    });
    const lines = sorted.map(
      (m) => `  - ${m.from} depends_on ${m.target} (not declared)`,
    );
    super(
      `dependency graph references unknown nodes:\n${lines.join("\n")}`,
    );
    this.name = "DependencyError";
    this.missing = sorted;
  }
}

/**
 * Validate that every `depends_on` target in the graph corresponds to a
 * declared node. Throws `DependencyError` listing every missing target.
 */
export function validateGraph(g: Graph): void {
  const missing: MissingDep[] = [];

  for (const [from, deps] of g.edges) {
    for (const target of deps) {
      if (!g.nodes.has(target)) {
        missing.push({ from, target });
      }
    }
  }

  if (missing.length > 0) {
    throw new DependencyError(missing);
  }
}
