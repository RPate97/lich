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

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly
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
  main_path: "/tmp/feature-x",
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
    profile: overrides.profile,
  };
}

describe("resolveEnvGroup (built-in stack)", () => {
  it("resolves the built-in stack group via resolveTopLevelEnv", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack",
        config: { version: "1", env: { TOP: "value" } },
      }),
    );
    expect(env.TOP).toBe("value");
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });
});

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
    expect(env.SHARED).toBe("from-child");
  });

  it("groups without extends do NOT include stack vars", async () => {
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
    expect(env.TOP).toBe("from-stack");
    expect(env.OWN).toBe("from-extended");
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });
});

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
    // parent's process_env policy is irrelevant when reached as a parent
    const env = await resolveEnvGroup(
      baseInput({
        name: "isolated-but-extends-stack",
        config: {
          version: "1",
          env: { TOP: "from-stack" },
          env_groups: {
            "isolated-but-extends-stack": {
              extends: "stack",
              process_env: false,
              env: { CHILD: "yes" },
            },
          },
        },
        processEnv: { LEAK: "from-shell" },
      }),
    );
    expect(env.TOP).toBe("from-stack");
    expect(env.CHILD).toBe("yes");
    expect(env.LEAK).toBeUndefined();
  });
});

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
    // cycle protection is config-wide — resolver can't proceed safely with any cyclic graph in scope
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

describe("resolveEnvGroup (profile threading)", () => {
  it("forwards profile to the built-in stack group: LICH_PROFILE is auto-injected", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack",
        config: { version: "1" },
        profile: {
          name: "dev:env-override",
          services: [],
          owned: [],
          env: {},
          env_files: [],
          env_from: [],
          lifecycle: { before_up: [], after_up: [], before_down: [] },
        },
      }),
    );
    expect(env.LICH_PROFILE).toBe("dev:env-override");
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });

  it("omits LICH_PROFILE when profile is undefined (Plan-1 behavior preserved)", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack",
        config: { version: "1" },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "LICH_PROFILE")).toBe(
      false,
    );
  });

  it("applies profile env layer to the stack group: profile env overrides top-level", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack",
        config: { version: "1", env: { DB: "top-level" } },
        profile: {
          name: "dev:env-override",
          services: [],
          owned: [],
          env: { DB: "from-profile" },
          env_files: [],
          env_from: [],
          lifecycle: { before_up: [], after_up: [], before_down: [] },
        },
      }),
    );
    expect(env.DB).toBe("from-profile");
  });

  it("forwards profile through extends: stack so derived groups see LICH_PROFILE", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "stack-plus",
        config: {
          version: "1",
          env_groups: {
            "stack-plus": {
              extends: "stack",
              env: { EXTRA: "yes" },
            },
          },
        },
        profile: {
          name: "dev",
          services: [],
          owned: [],
          env: {},
          env_files: [],
          env_from: [],
          lifecycle: { before_up: [], after_up: [], before_down: [] },
        },
      }),
    );
    expect(env.EXTRA).toBe("yes");
    expect(env.LICH_PROFILE).toBe("dev");
  });

  it("does NOT auto-inject LICH_PROFILE into a group that does NOT extend stack", async () => {
    // auto-inject only fires through the stack terminator (group isolation)
    const env = await resolveEnvGroup(
      baseInput({
        name: "isolated",
        config: {
          version: "1",
          env_groups: {
            isolated: { env: { ONLY: "this" } },
          },
        },
        profile: {
          name: "dev",
          services: [],
          owned: [],
          env: {},
          env_files: [],
          env_from: [],
          lifecycle: { before_up: [], after_up: [], before_down: [] },
        },
      }),
    );
    expect(env.ONLY).toBe("this");
    expect(Object.prototype.hasOwnProperty.call(env, "LICH_PROFILE")).toBe(
      false,
    );
  });
});

describe("resolveEnvGroup — env: { VAR: null } unsets", () => {
  it("outermost group literal null removes a process.env key", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "scrubbed",
        processEnv: { CANARY: "from-parent", KEEP: "still-here" },
        config: {
          version: "1",
          env_groups: {
            scrubbed: { env: { CANARY: null } },
          },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "CANARY")).toBe(false);
    expect(env.KEEP).toBe("still-here");
  });

  it("group that extends stack can null out a stack-supplied value", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "scrubbed",
        config: {
          version: "1",
          env: { TOP: "from-stack" },
          env_groups: {
            scrubbed: { extends: "stack", env: { TOP: null } },
          },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "TOP")).toBe(false);
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });

  it("child group's string value beats a parent group's null (later wins per key)", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "child",
        config: {
          version: "1",
          env_groups: {
            parent: { env: { FOO: null } },
            child: { extends: "parent", env: { FOO: "restored" } },
          },
        },
      }),
    );
    expect(env.FOO).toBe("restored");
  });

  it("env literal null beats same-group env_from value", async () => {
    const env = await resolveEnvGroup(
      baseInput({
        name: "scrubbed",
        config: {
          version: "1",
          env_groups: {
            scrubbed: {
              env_from: ['echo "BAZ=from-shell"'],
              env: { BAZ: null },
            },
          },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "BAZ")).toBe(false);
  });

  it("env_from cmd in a group does not see a parent group's nulled value as 'null'", async () => {
    // Node spawn coerces null env values to "null" string — must strip before passing to env_from
    const env = await resolveEnvGroup(
      baseInput({
        name: "child",
        processEnv: { FOO: "from-parent-shell" },
        config: {
          version: "1",
          env_groups: {
            parent: { env: { FOO: null } },
            child: {
              extends: "parent",
              env_from: [
                'printenv FOO > /dev/null && echo "PROBE=present" || echo "PROBE=MISSING"',
              ],
            },
          },
        },
      }),
    );
    expect(env.PROBE).toBe("MISSING");
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });
});
