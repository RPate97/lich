import { describe, it, expect } from "vitest";
import {
  ProfileCycleError,
  ProfileResolveError,
  resolveProfile,
  type ResolvedProfile,
} from "../../../src/profiles/resolve.js";
import type { LichConfig, ProfileDef } from "../../../src/config/types.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function configWith(profiles: Record<string, ProfileDef>): LichConfig {
  return { version: "1", profiles };
}

// ---------------------------------------------------------------------------
// Cases — passthrough / single-profile resolution
// ---------------------------------------------------------------------------

describe("resolveProfile (no extends — passthrough)", () => {
  it("resolves a single profile with no extends (passthrough)", () => {
    const result = resolveProfile(
      "dev",
      configWith({
        dev: {
          services: ["postgres"],
          owned: ["api"],
          env: { A: "1" },
          env_files: ["./a.env"],
          env_from: ["echo X=1"],
          lifecycle: {
            before_up: ["echo bu"],
            after_up: ["echo au"],
            before_down: ["echo bd"],
          },
        },
      }),
    );

    expect(result.name).toBe("dev");
    expect(result.services).toEqual(["postgres"]);
    expect(result.owned).toEqual(["api"]);
    expect(result.env).toEqual({ A: "1" });
    expect(result.env_files).toEqual(["./a.env"]);
    expect(result.env_from).toEqual(["echo X=1"]);
    expect(result.lifecycle.before_up).toEqual(["echo bu"]);
    expect(result.lifecycle.after_up).toEqual(["echo au"]);
    expect(result.lifecycle.before_down).toEqual(["echo bd"]);
  });

  it("returns empty arrays/objects for fields the profile doesn't declare", () => {
    const result = resolveProfile("bare", configWith({ bare: {} }));

    expect(result.name).toBe("bare");
    expect(result.services).toEqual([]);
    expect(result.owned).toEqual([]);
    expect(result.env).toEqual({});
    expect(result.env_files).toEqual([]);
    expect(result.env_from).toEqual([]);
    expect(result.lifecycle.before_up).toEqual([]);
    expect(result.lifecycle.after_up).toEqual([]);
    expect(result.lifecycle.before_down).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cases — services / owned union semantics
// ---------------------------------------------------------------------------

describe("resolveProfile (services / owned union)", () => {
  it("unions services and owned across extends chain (parents first)", () => {
    const result = resolveProfile(
      "full",
      configWith({
        base: { services: ["postgres"], owned: ["api"] },
        full: {
          extends: "base",
          services: ["redis"],
          owned: ["worker"],
        },
      }),
    );

    expect(result.services).toEqual(["postgres", "redis"]);
    expect(result.owned).toEqual(["api", "worker"]);
  });

  it("deduplicates services and owned (a service in both parent and child appears once)", () => {
    const result = resolveProfile(
      "full",
      configWith({
        base: { services: ["postgres", "redis"], owned: ["api", "worker"] },
        full: {
          extends: "base",
          // Parent already lists postgres/api; child re-declares + adds new.
          services: ["postgres", "kafka"],
          owned: ["api", "scheduler"],
        },
      }),
    );

    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);
  });
});

// ---------------------------------------------------------------------------
// Cases — env layering
// ---------------------------------------------------------------------------

describe("resolveProfile (env layering)", () => {
  it("layers env: child key overrides parent key with same name", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { env: { DATABASE_URL: "postgres://base/db" } },
        child: {
          extends: "base",
          env: { DATABASE_URL: "postgres://child/db" },
        },
      }),
    );

    expect(result.env).toEqual({ DATABASE_URL: "postgres://child/db" });
  });

  it("layers env: parent-only keys survive into the child", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { env: { DATABASE_URL: "postgres://base/db", LOG_LEVEL: "info" } },
        child: {
          extends: "base",
          env: { DATABASE_URL: "postgres://child/db" },
        },
      }),
    );

    expect(result.env).toEqual({
      DATABASE_URL: "postgres://child/db",
      LOG_LEVEL: "info", // parent-only key preserved
    });
  });
});

// ---------------------------------------------------------------------------
// Cases — env_files / env_from concatenation
// ---------------------------------------------------------------------------

describe("resolveProfile (env_files / env_from concatenation)", () => {
  it("concatenates env_files: parent files first, then child files", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { env_files: ["./base.env"] },
        child: { extends: "base", env_files: ["./child.env"] },
      }),
    );

    expect(result.env_files).toEqual(["./base.env", "./child.env"]);
  });

  it("concatenates env_from: parent entries first, then child entries", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { env_from: ["echo BASE=1"] },
        child: { extends: "base", env_from: ["echo CHILD=2"] },
      }),
    );

    expect(result.env_from).toEqual(["echo BASE=1", "echo CHILD=2"]);
  });

  it("preserves the env_files order across a 2-parent array extends", () => {
    // Documents declared-order semantics for env_files concat.
    const result = resolveProfile(
      "child",
      configWith({
        a: { env_files: ["./a.env"] },
        b: { env_files: ["./b.env"] },
        child: { extends: ["a", "b"], env_files: ["./child.env"] },
      }),
    );

    expect(result.env_files).toEqual(["./a.env", "./b.env", "./child.env"]);
  });
});

// ---------------------------------------------------------------------------
// Cases — lifecycle composition
// ---------------------------------------------------------------------------

describe("resolveProfile (lifecycle composition)", () => {
  it("composes lifecycle.before_up: parent entries first, then child entries", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { lifecycle: { before_up: ["echo base-bu"] } },
        child: { extends: "base", lifecycle: { before_up: ["echo child-bu"] } },
      }),
    );

    expect(result.lifecycle.before_up).toEqual([
      "echo base-bu",
      "echo child-bu",
    ]);
  });

  it("composes lifecycle.after_up: parent entries first, then child entries", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { lifecycle: { after_up: ["echo base-au"] } },
        child: { extends: "base", lifecycle: { after_up: ["echo child-au"] } },
      }),
    );

    expect(result.lifecycle.after_up).toEqual([
      "echo base-au",
      "echo child-au",
    ]);
  });

  it("composes lifecycle.before_down: child entries first, then parent entries (LIFO)", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { lifecycle: { before_down: ["echo base-bd"] } },
        child: { extends: "base", lifecycle: { before_down: ["echo child-bd"] } },
      }),
    );

    // LIFO: child entries run FIRST (undo specialization), then parent.
    expect(result.lifecycle.before_down).toEqual([
      "echo child-bd",
      "echo base-bd",
    ]);
  });

  it("composes lifecycle.before_down across multiple parents (LIFO across the chain)", () => {
    // Array-form extends: [a, b]; child runs first, then a, then b — wait,
    // per spec: child first, then parents in declared order (parent[0] runs
    // BEFORE parent[1], which feels not-LIFO across parents but matches the
    // documented contract: "child first, then parents" without specifying
    // parent re-ordering).
    const result = resolveProfile(
      "child",
      configWith({
        a: { lifecycle: { before_down: ["echo a-bd"] } },
        b: { lifecycle: { before_down: ["echo b-bd"] } },
        child: {
          extends: ["a", "b"],
          lifecycle: { before_down: ["echo child-bd"] },
        },
      }),
    );

    expect(result.lifecycle.before_down).toEqual([
      "echo child-bd",
      "echo a-bd",
      "echo b-bd",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cases — array-form extends
// ---------------------------------------------------------------------------

describe("resolveProfile (array-form extends)", () => {
  it("handles array-form extends [a, b]: a layered, then b layered, then child layered", () => {
    const result = resolveProfile(
      "child",
      configWith({
        a: {
          services: ["postgres"],
          owned: ["api"],
          env: { A: "from-a", SHARED: "a-wins" },
        },
        b: {
          services: ["redis"],
          owned: ["worker"],
          env: { B: "from-b", SHARED: "b-wins" }, // overrides A.SHARED
        },
        child: {
          extends: ["a", "b"],
          services: ["kafka"],
          owned: ["scheduler"],
          env: { CHILD: "from-child" },
        },
      }),
    );

    // Services: a, b, child (parents first, in declared order).
    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);

    // Env: a layered, then b (overrides SHARED), then child.
    expect(result.env).toEqual({
      A: "from-a",
      B: "from-b",
      SHARED: "b-wins",
      CHILD: "from-child",
    });
  });

  it("respects array extends order when the second parent overrides the first", () => {
    const result = resolveProfile(
      "child",
      configWith({
        a: { env: { KEY: "from-a" } },
        b: { env: { KEY: "from-b" } },
        child: { extends: ["a", "b"] },
      }),
    );

    // b is the LATER parent, so it wins over a; child has no override.
    expect(result.env).toEqual({ KEY: "from-b" });
  });
});

// ---------------------------------------------------------------------------
// Cases — deep chains
// ---------------------------------------------------------------------------

describe("resolveProfile (deep chains)", () => {
  it("resolves a 3-deep chain: root → mid → leaf", () => {
    const result = resolveProfile(
      "leaf",
      configWith({
        root: {
          services: ["postgres"],
          owned: ["api"],
          env: { ROOT: "1", SHARED: "root-wins" },
          env_files: ["./root.env"],
          lifecycle: {
            before_up: ["echo root-bu"],
            after_up: ["echo root-au"],
            before_down: ["echo root-bd"],
          },
        },
        mid: {
          extends: "root",
          services: ["redis"],
          owned: ["worker"],
          env: { MID: "1", SHARED: "mid-wins" },
          env_files: ["./mid.env"],
          lifecycle: {
            before_up: ["echo mid-bu"],
            after_up: ["echo mid-au"],
            before_down: ["echo mid-bd"],
          },
        },
        leaf: {
          extends: "mid",
          services: ["kafka"],
          owned: ["scheduler"],
          env: { LEAF: "1", SHARED: "leaf-wins" },
          env_files: ["./leaf.env"],
          lifecycle: {
            before_up: ["echo leaf-bu"],
            after_up: ["echo leaf-au"],
            before_down: ["echo leaf-bd"],
          },
        },
      }),
    );

    // services / owned: union in chain order (root → mid → leaf).
    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);

    // env: leaf wins on SHARED; root/mid-only keys preserved.
    expect(result.env).toEqual({
      ROOT: "1",
      MID: "1",
      LEAF: "1",
      SHARED: "leaf-wins",
    });

    // env_files: root → mid → leaf concat.
    expect(result.env_files).toEqual(["./root.env", "./mid.env", "./leaf.env"]);

    // before_up / after_up: parents first then child, through all 3 levels.
    expect(result.lifecycle.before_up).toEqual([
      "echo root-bu",
      "echo mid-bu",
      "echo leaf-bu",
    ]);
    expect(result.lifecycle.after_up).toEqual([
      "echo root-au",
      "echo mid-au",
      "echo leaf-au",
    ]);

    // before_down: LIFO — leaf first, mid next, root last.
    expect(result.lifecycle.before_down).toEqual([
      "echo leaf-bd",
      "echo mid-bd",
      "echo root-bd",
    ]);
  });

  it("memoizes a shared ancestor in diamond inheritance (resolves root once)", () => {
    // child → [a, b] → root. The resolver MUST realize root once (memo); the
    // observable effect is that root's env/services don't get duplicated.
    const result: ResolvedProfile = resolveProfile(
      "child",
      configWith({
        root: { services: ["postgres"], env: { ROOT: "1" } },
        a: { extends: "root", services: ["a-svc"] },
        b: { extends: "root", services: ["b-svc"] },
        child: { extends: ["a", "b"] },
      }),
    );

    // postgres MUST appear exactly once even though root is reached via both
    // a and b. (The appendDeduped logic guarantees this, and the memo keeps
    // resolution cost linear.)
    expect(result.services).toEqual(["postgres", "a-svc", "b-svc"]);
    expect(result.env).toEqual({ ROOT: "1" });
  });
});

// ---------------------------------------------------------------------------
// Cases — error paths
// ---------------------------------------------------------------------------

describe("resolveProfile (errors)", () => {
  it("throws ProfileResolveError with suggestion when name typo", () => {
    expect(() =>
      resolveProfile(
        "dev:tst-env",
        configWith({
          dev: { owned: ["api"], default: true },
          "dev:test-env": { owned: ["api"] },
        }),
      ),
    ).toThrowError(ProfileResolveError);

    try {
      resolveProfile(
        "dev:tst-env",
        configWith({
          dev: { owned: ["api"], default: true },
          "dev:test-env": { owned: ["api"] },
        }),
      );
      throw new Error("expected resolveProfile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileResolveError);
      const e = err as ProfileResolveError;
      expect(e.requestedName).toBe("dev:tst-env");
      expect(e.suggestion).toBe("dev:test-env");
      expect(e.message).toContain("dev:tst-env");
      expect(e.message).toContain("dev:test-env");
    }
  });

  it("throws ProfileResolveError without a suggestion when no close match exists", () => {
    try {
      resolveProfile(
        "totally-unrelated-name",
        configWith({ dev: {}, prod: {} }),
      );
      throw new Error("expected resolveProfile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileResolveError);
      const e = err as ProfileResolveError;
      expect(e.requestedName).toBe("totally-unrelated-name");
      expect(e.suggestion).toBeNull();
    }
  });

  it("throws ProfileResolveError when profiles map is absent", () => {
    // No `profiles` field at all — every name is undeclared.
    expect(() =>
      resolveProfile("dev", { version: "1" }),
    ).toThrowError(ProfileResolveError);
  });

  it("throws ProfileCycleError when extends has a cycle", () => {
    expect(() =>
      resolveProfile(
        "a",
        configWith({
          a: { extends: "b" },
          b: { extends: "a" },
        }),
      ),
    ).toThrowError(ProfileCycleError);

    try {
      resolveProfile(
        "a",
        configWith({
          a: { extends: "b" },
          b: { extends: "a" },
        }),
      );
      throw new Error("expected resolveProfile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileCycleError);
      const e = err as ProfileCycleError;
      // Cycle includes both nodes; start node repeats at the end.
      expect(e.cycle[0]).toBe(e.cycle[e.cycle.length - 1]);
      expect(new Set(e.cycle)).toEqual(new Set(["a", "b"]));
      expect(e.message).toContain("cycle in profiles extends");
    }
  });

  it("throws ProfileResolveError when extends references an undeclared parent", () => {
    // No cycle; just a missing parent reference reached during recursion.
    expect(() =>
      resolveProfile(
        "child",
        configWith({
          child: { extends: "ghost" },
        }),
      ),
    ).toThrowError(ProfileResolveError);
  });
});
