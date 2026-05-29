import { describe, it, expect } from "vitest";
import { detectProfileExtendsCycle } from "../../../src/profiles/validate-extends.js";
import type { ProfileDef } from "../../../src/config/types.js";

function profiles(
  spec: Record<string, string | string[] | null>,
): Record<string, ProfileDef> {
  const out: Record<string, ProfileDef> = {};
  for (const [name, parent] of Object.entries(spec)) {
    out[name] = parent === null ? {} : { extends: parent };
  }
  return out;
}

describe("detectProfileExtendsCycle (acyclic graphs)", () => {
  it("returns null for an empty profiles map", () => {
    expect(detectProfileExtendsCycle({})).toBeNull();
  });

  it("returns null for a single non-extending profile", () => {
    expect(detectProfileExtendsCycle(profiles({ a: null }))).toBeNull();
  });

  it("returns null for a 3-node chain dev -> base -> root", () => {
    expect(
      detectProfileExtendsCycle(
        profiles({ dev: "base", base: "root", root: null }),
      ),
    ).toBeNull();
  });

  it("returns null when extends points at an undeclared profile (resolver's concern, not ours)", () => {
    expect(detectProfileExtendsCycle(profiles({ a: "ghost" }))).toBeNull();
  });

  it("returns null for several disconnected acyclic chains", () => {
    expect(
      detectProfileExtendsCycle(
        profiles({
          a: "b",
          b: null,
          c: "d",
          d: null,
          isolated: null,
        }),
      ),
    ).toBeNull();
  });

  it("returns null for an acyclic graph reached via array-form extends", () => {
    expect(
      detectProfileExtendsCycle(
        profiles({ child: ["a", "b"], a: null, b: null }),
      ),
    ).toBeNull();
  });

  it("returns null for a diamond inheritance (acyclic)", () => {
    expect(
      detectProfileExtendsCycle(
        profiles({ child: ["a", "b"], a: "root", b: "root", root: null }),
      ),
    ).toBeNull();
  });
});

describe("detectProfileExtendsCycle (cyclic graphs)", () => {
  it("detects a self-loop a -> a", () => {
    const result = detectProfileExtendsCycle(profiles({ a: "a" }));
    expect(result).not.toBeNull();
    expect(result?.cycle).toEqual(["a", "a"]);
  });

  it("detects a 2-node cycle a -> b -> a", () => {
    const result = detectProfileExtendsCycle(profiles({ a: "b", b: "a" }));
    expect(result).not.toBeNull();
    expect(result?.cycle.length).toBe(3);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b"]));
  });

  it("detects a 3-node cycle a -> b -> c -> a", () => {
    const result = detectProfileExtendsCycle(
      profiles({ a: "b", b: "c", c: "a" }),
    );
    expect(result).not.toBeNull();
    expect(result?.cycle.length).toBe(4);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("detects cycles through array-form extends (extends: [a, b])", () => {
    const result = detectProfileExtendsCycle(
      profiles({ child: ["a", "b"], a: null, b: "child" }),
    );
    expect(result).not.toBeNull();
    expect(result?.cycle.length).toBe(3);
    expect(result?.cycle[0]).toBe(result?.cycle[result.cycle.length - 1]);
    expect(new Set(result?.cycle)).toEqual(new Set(["b", "child"]));
  });

  it("reports cycle nodes in walk order", () => {
    // alphabetical DFS: a -> b -> c -> a
    const result = detectProfileExtendsCycle(
      profiles({ a: "b", b: "c", c: "a" }),
    );
    expect(result?.cycle).toEqual(["a", "b", "c", "a"]);
  });

  it("detects a cycle even when reached through a non-cyclic prefix", () => {
    // prefix isn't part of cycle — reports ["b","b"] not ["a","b","b"]
    const result = detectProfileExtendsCycle(profiles({ a: "b", b: "b" }));
    expect(result?.cycle).toEqual(["b", "b"]);
  });

  it("detects a cycle introduced by the second parent in an array-form extends", () => {
    const result = detectProfileExtendsCycle(
      profiles({
        child: ["innocent", "evil"],
        innocent: null,
        evil: "child",
      }),
    );
    expect(result).not.toBeNull();
    expect(new Set(result?.cycle)).toEqual(new Set(["child", "evil"]));
  });
});
