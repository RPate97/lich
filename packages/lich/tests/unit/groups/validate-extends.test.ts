import { describe, it, expect } from "vitest";
import { detectExtendsCycle } from "../../../src/groups/validate-extends.js";
import type { EnvGroupDef } from "../../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal `env_groups` map from `name -> extends-target-or-null`.
 * Keeps the test fixtures terse and focused on the extends graph.
 */
function groups(
  spec: Record<string, string | null>,
): Record<string, EnvGroupDef> {
  const out: Record<string, EnvGroupDef> = {};
  for (const [name, parent] of Object.entries(spec)) {
    out[name] = parent === null ? {} : { extends: parent };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acyclic cases — should return null
// ---------------------------------------------------------------------------

describe("detectExtendsCycle (acyclic graphs)", () => {
  it("returns null for an empty groups map", () => {
    expect(detectExtendsCycle({})).toBeNull();
  });

  it("returns null for a single non-extending group", () => {
    expect(detectExtendsCycle(groups({ a: null }))).toBeNull();
  });

  it("returns null when extends terminates at the built-in stack", () => {
    // `stack` is the built-in terminator — not present in env_groups but
    // a valid leaf target.
    expect(detectExtendsCycle(groups({ a: "stack" }))).toBeNull();
  });

  it("returns null even if a user group name happens to be 'nonsense' and points at stack", () => {
    // Mirrors the spec's exact phrasing: the built-in `stack` IS the
    // terminator, regardless of how user groups are named.
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
    // A missing reference is NOT a cycle. Resolver reports the missing ref;
    // this detector is purely structural.
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

// ---------------------------------------------------------------------------
// Cyclic cases — should return { cycle: [...] }
// ---------------------------------------------------------------------------

describe("detectExtendsCycle (cyclic graphs)", () => {
  it("detects a self-loop a -> a", () => {
    const result = detectExtendsCycle(groups({ a: "a" }));
    expect(result).not.toBeNull();
    expect(result?.cycle).toEqual(["a", "a"]);
  });

  it("detects a 2-node cycle a -> b -> a", () => {
    const result = detectExtendsCycle(groups({ a: "b", b: "a" }));
    expect(result).not.toBeNull();
    // Closed walk: start node repeated at the end (matches CycleError shape
    // from deps/sort.ts — see e.g. ["a", "a"] for a self-loop there).
    expect(result?.cycle.length).toBe(3);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b"]));
  });

  it("detects a 3-node cycle a -> b -> c -> a", () => {
    const result = detectExtendsCycle(
      groups({ a: "b", b: "c", c: "a" }),
    );
    expect(result).not.toBeNull();
    // 3-cycle closed walk has 4 entries (start repeated).
    expect(result?.cycle.length).toBe(4);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("reports the cycle nodes in walk order", () => {
    // Entry sort is alphabetical → DFS starts at 'a' → walks a, b, c, then
    // c.extends = a closes the cycle. Expected walk: a -> b -> c -> a.
    const result = detectExtendsCycle(
      groups({ a: "b", b: "c", c: "a" }),
    );
    expect(result?.cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("reports a cycle even when reached through a non-cyclic prefix", () => {
    // 'a' extends 'b', which is in a self-cycle. DFS from 'a' enters 'b',
    // then 'b' walks to itself (self-loop) — the reported cycle is just
    // ["b", "b"], not ["a", "b", "b"] (the prefix isn't part of the cycle).
    const result = detectExtendsCycle(groups({ a: "b", b: "b" }));
    expect(result?.cycle).toEqual(["b", "b"]);
  });

  it("reports the cycle once, not once per entry point", () => {
    // Two entry points 'a' and 'c' both lead into the b<->d cycle. Should
    // return ONE cycle (the first one found), not two.
    const result = detectExtendsCycle(
      groups({ a: "b", b: "d", c: "d", d: "b" }),
    );
    expect(result).not.toBeNull();
    // Cycle is b <-> d; closed walk is 3 entries with start repeated.
    expect(result?.cycle.length).toBe(3);
    expect(new Set(result?.cycle)).toEqual(new Set(["b", "d"]));
  });
});
