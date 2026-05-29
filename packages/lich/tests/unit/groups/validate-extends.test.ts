import { describe, it, expect } from "vitest";
import { detectExtendsCycle } from "../../../src/groups/validate-extends.js";
import type { EnvGroupDef } from "../../../src/config/types.js";

function groups(
  spec: Record<string, string | null>,
): Record<string, EnvGroupDef> {
  const out: Record<string, EnvGroupDef> = {};
  for (const [name, parent] of Object.entries(spec)) {
    out[name] = parent === null ? {} : { extends: parent };
  }
  return out;
}

describe("detectExtendsCycle (acyclic graphs)", () => {
  it("returns null for an empty groups map", () => {
    expect(detectExtendsCycle({})).toBeNull();
  });

  it("returns null for a single non-extending group", () => {
    expect(detectExtendsCycle(groups({ a: null }))).toBeNull();
  });

  it("returns null when extends terminates at the built-in stack", () => {
    expect(detectExtendsCycle(groups({ a: "stack" }))).toBeNull();
  });

  it("returns null even if a user group name happens to be 'nonsense' and points at stack", () => {
    expect(
      detectExtendsCycle(groups({ nonsense: "stack", other: null })),
    ).toBeNull();
  });

  it("returns null for a 3-node chain a -> b -> c", () => {
    expect(
      detectExtendsCycle(groups({ a: "b", b: "c", c: null })),
    ).toBeNull();
  });

  it("returns null for a chain that ultimately terminates at stack", () => {
    expect(
      detectExtendsCycle(groups({ a: "b", b: "c", c: "stack" })),
    ).toBeNull();
  });

  it("returns null when extends points at an undeclared group (resolver's concern, not ours)", () => {
    expect(detectExtendsCycle(groups({ a: "ghost" }))).toBeNull();
  });

  it("returns null for several disconnected acyclic chains", () => {
    expect(
      detectExtendsCycle(
        groups({
          a: "b",
          b: null,
          c: "d",
          d: "stack",
          isolated: null,
        }),
      ),
    ).toBeNull();
  });
});

describe("detectExtendsCycle (cyclic graphs)", () => {
  it("detects a self-loop a -> a", () => {
    const result = detectExtendsCycle(groups({ a: "a" }));
    expect(result).not.toBeNull();
    expect(result?.cycle).toEqual(["a", "a"]);
  });

  it("detects a 2-node cycle a -> b -> a", () => {
    const result = detectExtendsCycle(groups({ a: "b", b: "a" }));
    expect(result).not.toBeNull();
    // closed walk: start node repeated at the end
    expect(result?.cycle.length).toBe(3);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b"]));
  });

  it("detects a 3-node cycle a -> b -> c -> a", () => {
    const result = detectExtendsCycle(
      groups({ a: "b", b: "c", c: "a" }),
    );
    expect(result).not.toBeNull();
    expect(result?.cycle.length).toBe(4);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("reports the cycle nodes in walk order", () => {
    // alphabetical DFS: a -> b -> c -> a
    const result = detectExtendsCycle(
      groups({ a: "b", b: "c", c: "a" }),
    );
    expect(result?.cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("reports a cycle even when reached through a non-cyclic prefix", () => {
    // prefix isn't part of the cycle — reported cycle is just ["b","b"]
    const result = detectExtendsCycle(groups({ a: "b", b: "b" }));
    expect(result?.cycle).toEqual(["b", "b"]);
  });

  it("reports the cycle once, not once per entry point", () => {
    const result = detectExtendsCycle(
      groups({ a: "b", b: "d", c: "d", d: "b" }),
    );
    expect(result).not.toBeNull();
    expect(result?.cycle.length).toBe(3);
    expect(new Set(result?.cycle)).toEqual(new Set(["b", "d"]));
  });
});
