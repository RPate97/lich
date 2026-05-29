import { describe, it, expect } from "vitest";
import {
  ProfileCycleError,
  ProfileResolveError,
  resolveProfile,
  type ResolvedProfile,
} from "../../../src/profiles/resolve.js";
import type { LichConfig, ProfileDef } from "../../../src/config/types.js";

function configWith(profiles: Record<string, ProfileDef>): LichConfig {
  return { version: "1", profiles };
}

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
            after_down: ["echo ad"],
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
    expect(result.lifecycle.after_down).toEqual(["echo ad"]);
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
    expect(result.lifecycle.after_down).toEqual([]);
  });
});

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
          services: ["postgres", "kafka"],
          owned: ["api", "scheduler"],
        },
      }),
    );

    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);
  });
});

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
      LOG_LEVEL: "info",
    });
  });
});

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

    // LIFO: child entries run FIRST (undo specialization), then parent
    expect(result.lifecycle.before_down).toEqual([
      "echo child-bd",
      "echo base-bd",
    ]);
  });

  it("composes lifecycle.before_down across multiple parents (LIFO across the chain)", () => {
    // spec: child first, then parents in declared order (parent[0] before parent[1])
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

  it("composes lifecycle.after_down: child entries first, then parent entries (LIFO)", () => {
    const result = resolveProfile(
      "child",
      configWith({
        base: { lifecycle: { after_down: ["echo base-ad"] } },
        child: {
          extends: "base",
          lifecycle: { after_down: ["echo child-ad"] },
        },
      }),
    );

    expect(result.lifecycle.after_down).toEqual([
      "echo child-ad",
      "echo base-ad",
    ]);
  });

  it("composes lifecycle.after_down across multiple parents (LIFO across the chain)", () => {
    const result = resolveProfile(
      "child",
      configWith({
        a: { lifecycle: { after_down: ["echo a-ad"] } },
        b: { lifecycle: { after_down: ["echo b-ad"] } },
        child: {
          extends: ["a", "b"],
          lifecycle: { after_down: ["echo child-ad"] },
        },
      }),
    );

    expect(result.lifecycle.after_down).toEqual([
      "echo child-ad",
      "echo a-ad",
      "echo b-ad",
    ]);
  });

  it("returns empty after_down array when nothing in the chain declares it", () => {
    const result = resolveProfile("bare", configWith({ bare: {} }));
    expect(result.lifecycle.after_down).toEqual([]);
  });
});

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

    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);

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

    expect(result.env).toEqual({ KEY: "from-b" });
  });
});

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
            after_down: ["echo root-ad"],
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
            after_down: ["echo mid-ad"],
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
            after_down: ["echo leaf-ad"],
          },
        },
      }),
    );

    expect(result.services).toEqual(["postgres", "redis", "kafka"]);
    expect(result.owned).toEqual(["api", "worker", "scheduler"]);

    expect(result.env).toEqual({
      ROOT: "1",
      MID: "1",
      LEAF: "1",
      SHARED: "leaf-wins",
    });

    expect(result.env_files).toEqual(["./root.env", "./mid.env", "./leaf.env"]);

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

    // before_down: LIFO — leaf first, mid next, root last
    expect(result.lifecycle.before_down).toEqual([
      "echo leaf-bd",
      "echo mid-bd",
      "echo root-bd",
    ]);

    expect(result.lifecycle.after_down).toEqual([
      "echo leaf-ad",
      "echo mid-ad",
      "echo root-ad",
    ]);
  });

  it("memoizes a shared ancestor in diamond inheritance (resolves root once)", () => {
    // diamond: child → [a, b] → root — root realized once, deduped in output
    const result: ResolvedProfile = resolveProfile(
      "child",
      configWith({
        root: { services: ["postgres"], env: { ROOT: "1" } },
        a: { extends: "root", services: ["a-svc"] },
        b: { extends: "root", services: ["b-svc"] },
        child: { extends: ["a", "b"] },
      }),
    );

    expect(result.services).toEqual(["postgres", "a-svc", "b-svc"]);
    expect(result.env).toEqual({ ROOT: "1" });
  });
});

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
      expect(e.cycle[0]).toBe(e.cycle[e.cycle.length - 1]);
      expect(new Set(e.cycle)).toEqual(new Set(["a", "b"]));
      expect(e.message).toContain("cycle in profiles extends");
    }
  });

  it("throws ProfileResolveError when extends references an undeclared parent", () => {
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

// merge contract for `lich up` / `lich down`:
//   before_up / after_up: top-level entries first, then profile entries (append)
//   before_down: profile entries first, then top-level entries (LIFO)
// ---------------------------------------------------------------------------

describe("profile lifecycle merge with top-level (LEV-499)", () => {
  it("before_up: top-level entries run first, then profile entries (top-first append)", () => {
    const config: LichConfig = {
      version: "1",
      lifecycle: { before_up: ["top:install"] },
      profiles: {
        dev: { lifecycle: { before_up: ["profile:supabase-start"] } },
      },
    };
    const resolved = resolveProfile("dev", config);

    const composed = [
      ...(config.lifecycle?.before_up ?? []),
      ...(resolved.lifecycle.before_up ?? []),
    ];
    expect(composed).toEqual(["top:install", "profile:supabase-start"]);
  });

  it("after_up: top-level entries run first, then profile entries (top-first append)", () => {
    const config: LichConfig = {
      version: "1",
      lifecycle: { after_up: ["top:codegen"] },
      profiles: {
        dev: { lifecycle: { after_up: ["profile:db-migrate", "profile:db-seed"] } },
      },
    };
    const resolved = resolveProfile("dev", config);

    const composed = [
      ...(config.lifecycle?.after_up ?? []),
      ...(resolved.lifecycle.after_up ?? []),
    ];
    expect(composed).toEqual([
      "top:codegen",
      "profile:db-migrate",
      "profile:db-seed",
    ]);
  });

  it("before_down: profile entries run first, then top-level entries (LIFO inverse)", () => {
    const config: LichConfig = {
      version: "1",
      lifecycle: { before_down: ["top:dump-state"] },
      profiles: {
        dev: { lifecycle: { before_down: ["profile:db-dump"] } },
      },
    };
    const resolved = resolveProfile("dev", config);

    // LIFO: undo specialization (profile) before tearing down base (top-level)
    const composed: string[] = [];
    composed.push(...(resolved.lifecycle.before_down ?? []) as string[]);
    composed.push(...((config.lifecycle?.before_down ?? []) as string[]));
    expect(composed).toEqual(["profile:db-dump", "top:dump-state"]);
  });

  it("profile with no lifecycle block inherits ONLY the top-level entries (no replace)", () => {
    const config: LichConfig = {
      version: "1",
      lifecycle: {
        before_up: ["top:install"],
        after_up: ["top:codegen"],
        before_down: ["top:dump-state"],
      },
      profiles: {
        lite: { owned: ["api"] },
      },
    };
    const resolved = resolveProfile("lite", config);

    expect(resolved.lifecycle.before_up).toEqual([]);
    expect(resolved.lifecycle.after_up).toEqual([]);
    expect(resolved.lifecycle.before_down).toEqual([]);

    expect([
      ...(config.lifecycle?.before_up ?? []),
      ...(resolved.lifecycle.before_up ?? []),
    ]).toEqual(["top:install"]);
    expect([
      ...(config.lifecycle?.after_up ?? []),
      ...(resolved.lifecycle.after_up ?? []),
    ]).toEqual(["top:codegen"]);
    expect([
      ...(resolved.lifecycle.before_down ?? []),
      ...((config.lifecycle?.before_down ?? []) as string[]),
    ]).toEqual(["top:dump-state"]);
  });

  it("no top-level lifecycle: profile entries run alone (no synthesized top entries)", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        dev: {
          lifecycle: {
            before_up: ["profile:only-before"],
            after_up: ["profile:only-after"],
            before_down: ["profile:only-down"],
          },
        },
      },
    };
    const resolved = resolveProfile("dev", config);

    expect([
      ...(config.lifecycle?.before_up ?? []),
      ...(resolved.lifecycle.before_up ?? []),
    ]).toEqual(["profile:only-before"]);
    expect([
      ...(config.lifecycle?.after_up ?? []),
      ...(resolved.lifecycle.after_up ?? []),
    ]).toEqual(["profile:only-after"]);
    expect([
      ...(resolved.lifecycle.before_down ?? []),
      ...((config.lifecycle?.before_down ?? []) as string[]),
    ]).toEqual(["profile:only-down"]);
  });
});

describe("resolveProfile — discover parent expansion in owned:", () => {
  it("expands a discover parent name in profile owned: to its materialized children", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        default: { owned: ["api", "web", "events-workers"] },
      },
      _discoverParents: new Map([
        ["events-workers", ["billing-worker", "events-worker", "notifications-worker"]],
      ]),
    };

    const resolved = resolveProfile("default", config);

    expect(resolved.owned).toEqual([
      "api",
      "web",
      "billing-worker",
      "events-worker",
      "notifications-worker",
    ]);
  });

  it("back-compat: per-name listing of materialized services still works without a discover map", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        default: { owned: ["api", "billing-worker", "events-worker"] },
      },
    };

    const resolved = resolveProfile("default", config);
    expect(resolved.owned).toEqual(["api", "billing-worker", "events-worker"]);
  });

  it("deduplicates when a child name appears both explicitly and via parent expansion", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        default: { owned: ["api", "billing-worker", "events-workers"] },
      },
      _discoverParents: new Map([
        ["events-workers", ["billing-worker", "events-worker"]],
      ]),
    };

    const resolved = resolveProfile("default", config);
    expect(resolved.owned).toEqual(["api", "billing-worker", "events-worker"]);
  });

  it("expands discover parent names inherited via extends chain", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        base: { owned: ["api"] },
        full: { extends: "base", owned: ["events-workers"] },
      },
      _discoverParents: new Map([
        ["events-workers", ["billing-worker", "events-worker"]],
      ]),
    };

    const resolved = resolveProfile("full", config);
    expect(resolved.owned).toEqual(["api", "billing-worker", "events-worker"]);
  });

  it("handles a discover parent with zero matches (empty children list)", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        default: { owned: ["api", "events-workers"] },
      },
      _discoverParents: new Map([["events-workers", []]]),
    };

    const resolved = resolveProfile("default", config);
    expect(resolved.owned).toEqual(["api"]);
  });

  it("leaves unknown names (non-discover) in owned: unchanged", () => {
    const config: LichConfig = {
      version: "1",
      profiles: {
        default: { owned: ["api", "events-workers", "web"] },
      },
      _discoverParents: new Map([
        ["events-workers", ["billing-worker", "events-worker"]],
      ]),
    };

    const resolved = resolveProfile("default", config);
    expect(resolved.owned).toEqual([
      "api",
      "billing-worker",
      "events-worker",
      "web",
    ]);
  });
});
