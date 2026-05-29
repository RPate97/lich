import { describe, it, expect } from "vitest";
import { buildGraph, type NodeDecl } from "../../../src/deps/graph.js";
import {
  topoLevels,
  startupOrder,
  shutdownOrder,
  CycleError,
} from "../../../src/deps/sort.js";

function g(decls: NodeDecl[]) {
  return buildGraph(decls);
}

function c(name: string, depends_on: string[] = []): NodeDecl {
  return { name, kind: "compose", depends_on };
}

describe("deps/sort: topoLevels", () => {
  it("returns an empty array for an empty graph", () => {
    expect(topoLevels(g([]))).toEqual([]);
  });

  it("places a single isolated node in level 0", () => {
    expect(topoLevels(g([c("a")]))).toEqual([["a"]]);
  });

  it("orders a linear chain a -> b -> c -> d into four levels", () => {
    const levels = topoLevels(
      g([c("a"), c("b", ["a"]), c("c", ["b"]), c("d", ["c"])]),
    );
    expect(levels).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("orders a diamond into three levels [a], [b,c], [d]", () => {
    const levels = topoLevels(
      g([c("a"), c("b", ["a"]), c("c", ["a"]), c("d", ["b", "c"])]),
    );
    expect(levels).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("groups disconnected roots into level 0", () => {
    const levels = topoLevels(
      g([c("a"), c("b"), c("api", ["a"]), c("worker", ["b"])]),
    );
    expect(levels[0]).toEqual(["a", "b"]);
    expect(levels[1]).toEqual(["api", "worker"]);
  });

  it("sorts within a level alphabetically for determinism", () => {
    const levels = topoLevels(g([c("z"), c("a"), c("m")]));
    expect(levels).toEqual([["a", "m", "z"]]);
  });

  it("supports cross-kind edges (owned depends on compose, and vice versa)", () => {
    const levels = topoLevels(
      g([
        { name: "postgres", kind: "compose", depends_on: [] },
        { name: "migrator", kind: "owned", depends_on: ["postgres"] },
        { name: "api", kind: "owned", depends_on: ["migrator"] },
        { name: "cache", kind: "compose", depends_on: ["api"] },
      ]),
    );
    expect(levels).toEqual([["postgres"], ["migrator"], ["api"], ["cache"]]);
  });

  it("throws CycleError on a simple cycle a -> b -> c -> a", () => {
    const graph = g([
      c("a", ["c"]),
      c("b", ["a"]),
      c("c", ["b"]),
    ]);
    let caught: unknown;
    try {
      topoLevels(graph);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CycleError);
    const err = caught as CycleError;
    // closed cycle: first === last, length 4 for a 3-cycle
    expect(err.cycle.length).toBe(4);
    expect(err.cycle[0]).toBe(err.cycle[err.cycle.length - 1]);
    const distinct = new Set(err.cycle);
    expect(distinct).toEqual(new Set(["a", "b", "c"]));
    expect(err.message).toMatch(/cycle detected:/);
    expect(err.message).toContain("→");
  });

  it("throws CycleError on a self-loop a -> a", () => {
    let caught: unknown;
    try {
      topoLevels(g([c("a", ["a"])]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CycleError);
    const err = caught as CycleError;
    expect(err.cycle).toEqual(["a", "a"]);
  });

  it("isolates a cycle from a clean acyclic subgraph in the error", () => {
    let caught: unknown;
    try {
      topoLevels(
        g([c("clean"), c("a", ["clean"]), c("b", ["c"]), c("c", ["b"])]),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CycleError);
    const err = caught as CycleError;
    expect(new Set(err.cycle)).toEqual(new Set(["b", "c"]));
  });
});

describe("deps/sort: startupOrder / shutdownOrder", () => {
  it("startupOrder flattens levels in order", () => {
    const graph = g([c("a"), c("b", ["a"]), c("c", ["a"]), c("d", ["b", "c"])]);
    expect(startupOrder(graph)).toEqual(["a", "b", "c", "d"]);
  });

  it("shutdownOrder is the reverse of startupOrder", () => {
    const graph = g([c("a"), c("b", ["a"]), c("c", ["a"]), c("d", ["b", "c"])]);
    const up = startupOrder(graph);
    const down = shutdownOrder(graph);
    expect(down).toEqual([...up].reverse());
    expect(down).toEqual(["d", "c", "b", "a"]);
  });

  it("startupOrder is empty for an empty graph", () => {
    expect(startupOrder(g([]))).toEqual([]);
    expect(shutdownOrder(g([]))).toEqual([]);
  });

  it("startupOrder is alphabetical within a single level when all are roots", () => {
    expect(startupOrder(g([c("z"), c("a"), c("m")]))).toEqual(["a", "m", "z"]);
  });
});
