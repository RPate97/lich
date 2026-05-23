import { describe, it, expect } from "vitest";
import {
  buildGraph,
  validateGraph,
  DependencyError,
  type NodeDecl,
} from "../../../src/deps/graph.js";

describe("deps/graph: buildGraph", () => {
  it("constructs nodes and edges from a typical fixture", () => {
    const decls: NodeDecl[] = [
      { name: "postgres", kind: "compose", depends_on: [] },
      { name: "api", kind: "owned", depends_on: ["postgres"] },
      { name: "web", kind: "owned", depends_on: ["api"] },
    ];

    const g = buildGraph(decls);

    expect(g.nodes.size).toBe(3);
    expect(g.nodes.get("postgres")?.kind).toBe("compose");
    expect(g.nodes.get("api")?.kind).toBe("owned");
    expect(g.nodes.get("web")?.kind).toBe("owned");

    expect([...(g.edges.get("postgres") ?? [])]).toEqual([]);
    expect([...(g.edges.get("api") ?? [])]).toEqual(["postgres"]);
    expect([...(g.edges.get("web") ?? [])]).toEqual(["api"]);
  });

  it("deduplicates repeated dependency entries", () => {
    const g = buildGraph([
      { name: "db", kind: "compose", depends_on: [] },
      { name: "api", kind: "owned", depends_on: ["db", "db"] },
    ]);
    expect([...(g.edges.get("api") ?? [])]).toEqual(["db"]);
  });

  it("throws on duplicate node declarations", () => {
    expect(() =>
      buildGraph([
        { name: "api", kind: "compose", depends_on: [] },
        { name: "api", kind: "owned", depends_on: [] },
      ]),
    ).toThrow(/duplicate/i);
  });

  it("handles an empty input", () => {
    const g = buildGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
  });
});

describe("deps/graph: validateGraph", () => {
  it("passes for a clean graph", () => {
    const g = buildGraph([
      { name: "postgres", kind: "compose", depends_on: [] },
      { name: "api", kind: "owned", depends_on: ["postgres"] },
    ]);
    expect(() => validateGraph(g)).not.toThrow();
  });

  it("passes for an empty graph", () => {
    expect(() => validateGraph(buildGraph([]))).not.toThrow();
  });

  it("accepts cross-kind edges (owned -> compose)", () => {
    const g = buildGraph([
      { name: "postgres", kind: "compose", depends_on: [] },
      { name: "api", kind: "owned", depends_on: ["postgres"] },
    ]);
    expect(() => validateGraph(g)).not.toThrow();
  });

  it("accepts cross-kind edges (compose -> owned)", () => {
    const g = buildGraph([
      { name: "migrator", kind: "owned", depends_on: [] },
      { name: "postgres", kind: "compose", depends_on: ["migrator"] },
    ]);
    expect(() => validateGraph(g)).not.toThrow();
  });

  it("throws DependencyError listing EVERY missing target, not just the first", () => {
    const g = buildGraph([
      { name: "api", kind: "owned", depends_on: ["postgres", "redis"] },
      { name: "web", kind: "owned", depends_on: ["api", "cdn"] },
    ]);

    let caught: unknown;
    try {
      validateGraph(g);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DependencyError);
    const err = caught as DependencyError;

    expect(err.missing).toHaveLength(3);
    // sorted by from, then target
    expect(err.missing).toEqual([
      { from: "api", target: "postgres" },
      { from: "api", target: "redis" },
      { from: "web", target: "cdn" },
    ]);
    expect(err.message).toContain("postgres");
    expect(err.message).toContain("redis");
    expect(err.message).toContain("cdn");
  });

  it("does not throw when only the source is unknown (vacuous: nothing to check)", () => {
    // If a node isn't declared, there are no edges from it. validateGraph
    // only sees declared nodes.
    const g = buildGraph([{ name: "a", kind: "compose", depends_on: [] }]);
    expect(() => validateGraph(g)).not.toThrow();
  });
});
