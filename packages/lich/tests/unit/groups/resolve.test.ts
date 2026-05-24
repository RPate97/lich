import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveEnvGroup,
  GroupResolveError,
  GroupCycleError,
} from "../../../src/groups/resolve.js";
import type { LichConfig } from "../../../src/config/types.js";
import type { Worktree } from "../../../src/worktree/detect.js";
import type { AllocatedPorts } from "../../../src/state/snapshot.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lich-groups-resolve-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const worktree: Worktree = {
  name: "feature-x",
  id: "abc123def456",
  path: "/tmp/feature-x",
  stack_id: "feature-x-abc123de",
};

const noPorts: AllocatedPorts = { compose: {}, owned: {} };

function baseInput(
  overrides: Partial<Parameters<typeof resolveEnvGroup>[0]>,
): Parameters<typeof resolveEnvGroup>[0] {
  return {
    name: overrides.name ?? "stack",
    config: overrides.config ?? { version: "1" },
    worktree: overrides.worktree ?? worktree,
    allocatedPorts: overrides.allocatedPorts ?? noPorts,
    projectRoot: overrides.projectRoot ?? tmp,
    processEnv: overrides.processEnv ?? {},
  };
}

// ---------------------------------------------------------------------------
// Built-in stack
// ---------------------------------------------------------------------------

describe("resolveEnvGroup (built-in stack)", () => {
  it("resolves the built-in stack group via resolveTopLevelEnv", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack",
        config: { version: "1", env: { TOP: "value" } },
      }),
    );
    expect(env.TOP).toBe("value");
    // Auto-injects must survive the adapter (proves we genuinely delegated
    // to resolveTopLevelEnv, not a stub).
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });
});

// ---------------------------------------------------------------------------
// User-defined groups
// ---------------------------------------------------------------------------

describe("resolveEnvGroup (user-defined groups)", () => {
  it("resolves a user-defined group with only literal env", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "tools",
        config: {
          version: "1",
          env_groups: { tools: { env: { TOOL: "yes", N: 3 } } },
        },
      }),
    );
    // Literal values are coerced to strings.
    expect(env).toEqual({ TOOL: "yes", N: "3" });
  });

  it("applies extends: parent vars present, child overrides parent on key collision", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "child",
        config: {
          version: "1",
          env_groups: {
            parent: { env: { SHARED: "from-parent", FROM_PARENT: "p" } },
            child: {
              extends: "parent",
              env: { SHARED: "from-child", FROM_CHILD: "c" },
            },
          },
        },
      }),
    );
    expect(env.FROM_PARENT).toBe("p");
    expect(env.FROM_CHILD).toBe("c");
    // Later wins: child overrides parent on the shared key.
    expect(env.SHARED).toBe("from-child");
  });

  it("groups without extends do NOT include stack vars", async () => {
    // Top-level env defines TOP; a user group without `extends` must NOT see it.
    const env = await resolveEnvGroup(
      baseInput({
        name: "foo",
        config: {
          version: "1",
          env: { TOP: "A" },
          env_groups: { foo: { env: { B: "b" } } },
        },
      }),
    );
    expect(env.B).toBe("b");
    expect(env.TOP).toBeUndefined();
    // Stack auto-injects are also absent — the group is fully isolated.
    expect(env.LICH_WORKTREE).toBeUndefined();
    expect(env.LICH_STACK_ID).toBeUndefined();
  });

  it("extends: stack explicitly includes stack vars", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "extended",
        config: {
          version: "1",
          env: { TOP: "from-stack" },
          env_groups: {
            extended: { extends: "stack", env: { OWN: "from-extended" } },
          },
        },
      }),
    );
    // Parent's literal env carries through.
    expect(env.TOP).toBe("from-stack");
    // This group's own literal carries through.
    expect(env.OWN).toBe("from-extended");
    // Stack auto-injects come along via the extends chain.
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });
});

// ---------------------------------------------------------------------------
// process_env policy
// ---------------------------------------------------------------------------

describe("resolveEnvGroup (process_env policy)", () => {
  it("process_env: false blocks shell env passthrough", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "isolated",
        config: {
          version: "1",
          env_groups: {
            isolated: { process_env: false, env: { OWN: "yes" } },
          },
        },
        processEnv: { LEAK: "oops" },
      }),
    );
    expect(env.OWN).toBe("yes");
    expect(env.LEAK).toBeUndefined();
  });

  it("process_env: true (default) overlays shell env at the outermost call", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "passthrough",
        config: {
          version: "1",
          env_groups: {
            passthrough: { env: { OWN: "yes" } },
          },
        },
        processEnv: { LEAK: "from-shell" },
      }),
    );
    expect(env.OWN).toBe("yes");
    expect(env.LEAK).toBe("from-shell");
  });

  it("process_env is honored at the outermost call only when extends terminates (extends: stack + process_env: false)", async () => {
    // A child group with extends: stack AND process_env: false should NOT
    // leak shell env. The parent (stack) gets its own process_env layer when
    // it's the OUTERMOST call, but here it's a parent reference — its
    // process_env overlay is suppressed because the outer call has
    // process_env: false. We assert this via: pass a processEnv that the
    // parent doesn't define; that var must NOT appear in the result.
    const env = await resolveEnvGroup(
      baseInput({
        name: "isolated-but-extends-stack",
        config: {
          version: "1",
          // stack would inject TOP, but no process.env passthrough.
          env: { TOP: "from-stack" },
          env_groups: {
            "isolated-but-extends-stack": {
              extends: "stack",
              process_env: false,
              env: { CHILD: "yes" },
            },
          },
        },
        // The shell env contains LEAK. With process_env: false at the
        // outermost, this must NOT bleed through (the stack parent's own
        // outermost-call process_env policy is irrelevant when it's
        // reached as a parent).
        processEnv: { LEAK: "from-shell" },
      }),
    );
    expect(env.TOP).toBe("from-stack");
    expect(env.CHILD).toBe("yes");
    expect(env.LEAK).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe("resolveEnvGroup (interpolation)", () => {
  it("interpolates ${owned.X.port} in env values", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "wired",
        config: {
          version: "1",
          env_groups: {
            wired: { env: { DB: "postgres://localhost:${owned.api.port}/app" } },
          },
        },
        allocatedPorts: {
          compose: {},
          owned: { api: { port: 7421 } },
        },
      }),
    );
    expect(env.DB).toBe("postgres://localhost:7421/app");
  });

  it("interpolates parent values consistently when reached via extends", async () => {
    // Parent declares a value referencing ${owned.api.port}; child extends
    // it. The interpolation pass runs once at the outermost call, so the
    // inherited value is resolved against the final context.
    const env = await resolveEnvGroup(
      baseInput({
        name: "child",
        config: {
          version: "1",
          env_groups: {
            parent: { env: { URL: "http://h:${owned.api.port}" } },
            child: { extends: "parent", env: { OWN: "x" } },
          },
        },
        allocatedPorts: {
          compose: {},
          owned: { api: { port: 9001 } },
        },
      }),
    );
    expect(env.URL).toBe("http://h:9001");
    expect(env.OWN).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("resolveEnvGroup (errors)", () => {
  it("throws GroupResolveError with suggestion when name typo", async () => {
    const config: LichConfig = {
      version: "1",
      env_groups: {
        "infisical-prod": { env: { X: "1" } },
      },
    };
    await expect(
      resolveEnvGroup(baseInput({ name: "infisical-prdo", config })),
    ).rejects.toThrow(GroupResolveError);
    // Verify the suggestion in the error message.
    try {
      await resolveEnvGroup(baseInput({ name: "infisical-prdo", config }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GroupResolveError);
      const ge = err as GroupResolveError;
      expect(ge.requestedName).toBe("infisical-prdo");
      expect(ge.suggestion).toBe("infisical-prod");
      expect(ge.message).toContain("infisical-prod");
    }
  });

  it("throws GroupResolveError without suggestion when no close match", async () => {
    const config: LichConfig = {
      version: "1",
      env_groups: { tools: { env: { X: "1" } } },
    };
    try {
      await resolveEnvGroup(baseInput({ name: "completely-different", config }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GroupResolveError);
      const ge = err as GroupResolveError;
      expect(ge.suggestion).toBeNull();
      expect(ge.message).not.toContain("did you mean");
    }
  });

  it("throws GroupResolveError when env_groups section is absent and name is not stack", async () => {
    await expect(
      resolveEnvGroup(baseInput({ name: "anything", config: { version: "1" } })),
    ).rejects.toThrow(GroupResolveError);
  });

  it("throws GroupCycleError when extends has a cycle", async () => {
    const config: LichConfig = {
      version: "1",
      env_groups: {
        a: { extends: "b", env: {} },
        b: { extends: "a", env: {} },
      },
    };
    try {
      await resolveEnvGroup(baseInput({ name: "a", config }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GroupCycleError);
      const ce = err as GroupCycleError;
      expect(ce.cycle.length).toBeGreaterThanOrEqual(3);
      expect(ce.cycle[0]).toBe(ce.cycle[ce.cycle.length - 1]);
      expect(ce.message).toContain("cycle in env_groups extends");
    }
  });

  it("throws GroupCycleError even when the outermost name is not on the cycle", async () => {
    // The cycle protection is a config-wide check — it fires regardless of
    // which name was requested, because the resolver can't proceed safely
    // with any cyclic graph in scope.
    const config: LichConfig = {
      version: "1",
      env_groups: {
        clean: { env: { X: "1" } },
        a: { extends: "b" },
        b: { extends: "a" },
      },
    };
    await expect(
      resolveEnvGroup(baseInput({ name: "clean", config })),
    ).rejects.toThrow(GroupCycleError);
  });
});
