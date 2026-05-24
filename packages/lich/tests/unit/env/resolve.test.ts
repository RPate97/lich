import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveEnvForService,
  resolveTopLevelEnv,
  type ResolveEnvForServiceInput,
} from "../../../src/env/resolve.js";
import type { LichConfig } from "../../../src/config/types.js";
import type { ResolvedProfile } from "../../../src/profiles/resolve.js";
import type { Worktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lich-resolve-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const p = path.join(tmp, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

const worktree: Worktree = {
  name: "feature-x",
  id: "abc123def456",
  path: "/tmp/feature-x",
  stack_id: "feature-x-abc123de",
};

function baseInput(
  overrides: Partial<ResolveEnvForServiceInput> = {},
): ResolveEnvForServiceInput {
  return {
    config: { version: "1" },
    service: { kind: "owned", name: "api" },
    worktree,
    allocatedPorts: { compose: {}, owned: {} },
    processEnv: {}, // empty by default so tests don't leak host env
    projectRoot: tmp,
    ...overrides,
  };
}

/**
 * Build a minimal ResolvedProfile for tests. `resolveProfile()` is exercised
 * separately in `profiles/resolve.test.ts`; these tests only care that the
 * env pipeline honors whatever shape is handed in, so we synthesize the
 * structure inline rather than going through the resolver.
 */
function makeProfile(
  overrides: Partial<ResolvedProfile> = {},
): ResolvedProfile {
  return {
    name: "dev",
    services: [],
    owned: [],
    env: {},
    env_files: [],
    env_from: [],
    lifecycle: { before_up: [], after_up: [], before_down: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveEnvForService — empty / baseline behaviour", () => {
  it("with no env layers, returns just process.env + auto-injects", async () => {
    const env = await resolveEnvForService(
      baseInput({ processEnv: { PATH: "/usr/bin", HOME: "/home/me" } }),
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LICH_WORKTREE: "feature-x",
      LICH_STACK_ID: "feature-x-abc123de",
    });
  });

  it("drops undefined values from process.env", async () => {
    const env = await resolveEnvForService(
      baseInput({
        processEnv: { KEPT: "yes", DROPPED: undefined as unknown as string },
      }),
    );
    expect(env.KEPT).toBe("yes");
    expect(Object.prototype.hasOwnProperty.call(env, "DROPPED")).toBe(false);
  });
});

describe("resolveEnvForService — single-layer sanity", () => {
  it("top-level env literal alone shows up in output", async () => {
    const env = await resolveEnvForService(
      baseInput({ config: { version: "1", env: { FOO: "bar" } } }),
    );
    expect(env.FOO).toBe("bar");
  });

  it("coerces numeric and boolean literals to strings", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { NUM: 42, FLAG: true } as Record<string, string | number | boolean>,
        },
      }),
    );
    expect(env.NUM).toBe("42");
    expect(env.FLAG).toBe("true");
  });

  it("top-level env_files alone loads values", async () => {
    write(".env", "FROM_FILE=present\n");
    const env = await resolveEnvForService(
      baseInput({ config: { version: "1", env_files: [".env"] } }),
    );
    expect(env.FROM_FILE).toBe("present");
  });

  it("top-level env_from alone loads values", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env_from: ['echo "FROM_SHELL=ok"'] },
      }),
    );
    expect(env.FROM_SHELL).toBe("ok");
  });

  it("absolute paths in env_files bypass projectRoot resolution", async () => {
    const f = write(".env", "ABS=yep\n");
    const env = await resolveEnvForService(
      baseInput({ config: { version: "1", env_files: [f] } }),
    );
    expect(env.ABS).toBe("yep");
  });
});

describe("resolveEnvForService — precedence (later wins)", () => {
  it("top-level env_from overrides process.env", async () => {
    const env = await resolveEnvForService(
      baseInput({
        processEnv: { COLLIDE: "from-process" },
        config: {
          version: "1",
          env_from: ['echo "COLLIDE=from-shell"'],
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-shell");
  });

  it("top-level env_files override top-level env_from", async () => {
    write(".env", "COLLIDE=from-file\n");
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "COLLIDE=from-shell"'],
          env_files: [".env"],
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-file");
  });

  it("top-level env literals override top-level env_files", async () => {
    write(".env", "COLLIDE=from-file\n");
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_files: [".env"],
          env: { COLLIDE: "from-literal" },
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-literal");
  });

  it("per-service env_from overrides top-level env literal", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { COLLIDE: "from-top-literal" },
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "COLLIDE=from-service-shell"'],
            },
          },
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-service-shell");
  });

  it("per-service env_files override per-service env_from", async () => {
    write("svc.env", "COLLIDE=from-service-file\n");
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "COLLIDE=from-service-shell"'],
              env_files: ["svc.env"],
            },
          },
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-service-file");
  });

  it("per-service env literals win overall", async () => {
    write(".env", "COLLIDE=from-top-file\n");
    write("svc.env", "COLLIDE=from-service-file\n");
    const env = await resolveEnvForService(
      baseInput({
        processEnv: { COLLIDE: "from-process" },
        config: {
          version: "1",
          env_from: ['echo "COLLIDE=from-top-shell"'],
          env_files: [".env"],
          env: { COLLIDE: "from-top-literal" },
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "COLLIDE=from-service-shell"'],
              env_files: ["svc.env"],
              env: { COLLIDE: "from-service-literal" },
            },
          },
        },
      }),
    );
    expect(env.COLLIDE).toBe("from-service-literal");
  });

  it("env_from entries within a single layer follow declared order", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: [
            'echo "K=first"',
            'echo "K=second"',
          ],
        },
      }),
    );
    expect(env.K).toBe("second");
  });
});

describe("resolveEnvForService — interpolation", () => {
  it("resolves ${owned.<name>.port} references in env values", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { URL: "postgres://localhost:${owned.db.port}" },
        },
        allocatedPorts: {
          compose: {},
          owned: { db: { port: 5847 } },
        },
      }),
    );
    expect(env.URL).toBe("postgres://localhost:5847");
  });

  it("resolves ${worktree.name} in env values", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { PROJECT: "lich-${worktree.name}" },
        },
      }),
    );
    expect(env.PROJECT).toBe("lich-feature-x");
  });

  it("resolves ${services.<name>.host_port} using the first allocated logical port", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { API_URL: "http://localhost:${services.web.host_port}" },
        },
        allocatedPorts: {
          compose: { web: { http: 13042 } },
          owned: {},
        },
      }),
    );
    expect(env.API_URL).toBe("http://localhost:13042");
  });

  it("interpolation failure throws InterpolationError with source context", async () => {
    await expect(
      resolveEnvForService(
        baseInput({
          config: {
            version: "1",
            env: { BAD: "${owned.missing.port}" },
          },
        }),
      ),
    ).rejects.toThrow(/owned.*missing.*port|no owned service named "missing"/i);
  });

  it("interpolation error references the failing env key", async () => {
    try {
      await resolveEnvForService(
        baseInput({
          config: {
            version: "1",
            env: { BAD_KEY: "${owned.missing.port}" },
          },
        }),
      );
      throw new Error("expected resolveEnvForService to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/BAD_KEY/);
    }
  });
});

describe("resolveEnvForService — auto-injection", () => {
  it("auto-injects LICH_WORKTREE and LICH_STACK_ID", async () => {
    const env = await resolveEnvForService(baseInput());
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });

  it("per-service env can override LICH_STACK_ID (user wins)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          owned: {
            api: {
              cmd: "echo",
              env: { LICH_STACK_ID: "my-override" },
            },
          },
        },
      }),
    );
    expect(env.LICH_STACK_ID).toBe("my-override");
    // LICH_WORKTREE still gets its auto value since no one overrode it.
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });

  it("auto-injects beat process.env (process.env can't accidentally clobber them)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        processEnv: {
          LICH_WORKTREE: "leaked-from-parent",
          LICH_STACK_ID: "leaked-too",
        },
      }),
    );
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
  });
});

describe("resolveEnvForService — error surfacing", () => {
  it("shell-out failure surfaces with the failed cmd in the error", async () => {
    await expect(
      resolveEnvForService(
        baseInput({
          config: {
            version: "1",
            env_from: [{ cmd: "exit 7" }],
          },
        }),
      ),
    ).rejects.toThrow(/exit 7/);
  });

  it("dotenv parse failure on a present file is propagated", async () => {
    write("broken.env", "this line has no equals sign\n");
    await expect(
      resolveEnvForService(
        baseInput({
          config: { version: "1", env_files: ["broken.env"] },
        }),
      ),
    ).rejects.toThrow(/missing '='|env_files/);
  });
});

describe("resolveEnvForService — compose-kind services", () => {
  it("for kind: 'compose' there is no per-service lich env layer (compose owns its environment)", async () => {
    // Top-level layers apply; per-service layer is a no-op since
    // ComposeService doesn't carry env_from/env_files/env on the lich side.
    const env = await resolveEnvForService(
      baseInput({
        service: { kind: "compose", name: "web" },
        config: {
          version: "1",
          env: { TOP: "applied" },
          services: { web: { image: "nginx" } },
        },
      }),
    );
    expect(env.TOP).toBe("applied");
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });

  it("compose service named in input but absent from config still gets top-level env", async () => {
    const env = await resolveEnvForService(
      baseInput({
        service: { kind: "compose", name: "ghost" },
        config: { version: "1", env: { TOP: "yes" } },
      }),
    );
    expect(env.TOP).toBe("yes");
  });
});

describe("resolveTopLevelEnv", () => {
  it("returns top-level layers + auto-injects, ignoring any per-service config", async () => {
    write(".env", "FROM_FILE=ok\n");
    const env = await resolveTopLevelEnv({
      config: {
        version: "1",
        env_from: ['echo "FROM_SHELL=ok"'],
        env_files: [".env"],
        env: { FROM_LITERAL: "ok" },
        // a per-service block is present but MUST be ignored:
        owned: {
          api: {
            cmd: "echo",
            env: { SHOULD_NOT_APPEAR: "leaked" },
          },
        },
      },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: { PATH: "/usr/bin" },
      projectRoot: tmp,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FROM_SHELL).toBe("ok");
    expect(env.FROM_FILE).toBe("ok");
    expect(env.FROM_LITERAL).toBe("ok");
    expect(env.LICH_WORKTREE).toBe("feature-x");
    expect(env.LICH_STACK_ID).toBe("feature-x-abc123de");
    expect(env.SHOULD_NOT_APPEAR).toBeUndefined();
  });

  it("runs interpolation on top-level env literal values", async () => {
    const env = await resolveTopLevelEnv({
      config: {
        version: "1",
        env: { URL: "db://${owned.db.port}" },
      },
      worktree,
      allocatedPorts: { compose: {}, owned: { db: { port: 9999 } } },
      processEnv: {},
      projectRoot: tmp,
    });
    expect(env.URL).toBe("db://9999");
  });
});

// ---------------------------------------------------------------------------
// Plan-3 Task 6 (LEV-380): profile layer + LICH_PROFILE auto-injection
// ---------------------------------------------------------------------------

describe("resolveEnvForService — profile layer", () => {
  it("applies profile env layer between top-level and per-service", async () => {
    // Top-level sets A=1; profile sets A=2 and adds B=p; no per-service.
    // Profile wins on A; profile-only B passes through.
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env: { A: "1" } },
        profile: makeProfile({ env: { A: "2", B: "p" } }),
      }),
    );
    expect(env.A).toBe("2");
    expect(env.B).toBe("p");
  });

  it("per-service still overrides profile", async () => {
    // Top → profile → per-service: per-service is the highest layer, so
    // its A=3 wins over the profile's A=2 (which in turn beat top's A=1).
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { A: "1" },
          owned: { api: { cmd: "echo", env: { A: "3" } } },
        },
        profile: makeProfile({ env: { A: "2" } }),
      }),
    );
    expect(env.A).toBe("3");
  });

  it("profile env_from is invoked when profile is present", async () => {
    // The shell-out is the load-bearing assertion: if the profile layer
    // wasn't wired, FROM_PROFILE_SHELL would never get loaded.
    const env = await resolveEnvForService(
      baseInput({
        profile: makeProfile({
          env_from: ['echo "FROM_PROFILE_SHELL=yes"'],
        }),
      }),
    );
    expect(env.FROM_PROFILE_SHELL).toBe("yes");
  });

  it("profile env_files contributes when present", async () => {
    write("profile.env", "FROM_PROFILE_FILE=yes\n");
    const env = await resolveEnvForService(
      baseInput({
        profile: makeProfile({ env_files: ["profile.env"] }),
      }),
    );
    expect(env.FROM_PROFILE_FILE).toBe("yes");
  });

  it("profile env_files override top-level env literals on key collision", async () => {
    // Profile layer (steps 6-8) sits ABOVE top-level (steps 3-5), so the
    // profile file's value should win over the top-level literal.
    write("profile.env", "COLLIDE=from-profile-file\n");
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env: { COLLIDE: "from-top-literal" } },
        profile: makeProfile({ env_files: ["profile.env"] }),
      }),
    );
    expect(env.COLLIDE).toBe("from-profile-file");
  });

  it("profile env literals override profile env_files on key collision (within-layer)", async () => {
    // Within the profile layer itself: env_from → env_files → env, same
    // precedence rule as the other two bundles. Profile literal wins.
    write("profile.env", "COLLIDE=from-profile-file\n");
    const env = await resolveEnvForService(
      baseInput({
        profile: makeProfile({
          env_files: ["profile.env"],
          env: { COLLIDE: "from-profile-literal" },
        }),
      }),
    );
    expect(env.COLLIDE).toBe("from-profile-literal");
  });

  it("undefined profile leaves behavior identical to Plan-1 (no LICH_PROFILE, no extra layer)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env: { A: "1" } },
      }),
    );
    expect(env.A).toBe("1");
    expect(env.LICH_PROFILE).toBeUndefined();
  });

  it("profile env_from runs ABOVE top-level env_from (later layer wins)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "COLLIDE=from-top-shell"'],
        },
        profile: makeProfile({
          env_from: ['echo "COLLIDE=from-profile-shell"'],
        }),
      }),
    );
    expect(env.COLLIDE).toBe("from-profile-shell");
  });
});

describe("resolveEnvForService — LICH_PROFILE auto-injection", () => {
  it("LICH_PROFILE is auto-injected when profile is active", async () => {
    const env = await resolveEnvForService(
      baseInput({ profile: makeProfile({ name: "dev:env-override" }) }),
    );
    expect(env.LICH_PROFILE).toBe("dev:env-override");
  });

  it("LICH_PROFILE is absent when no profile is active", async () => {
    const env = await resolveEnvForService(baseInput());
    expect(Object.prototype.hasOwnProperty.call(env, "LICH_PROFILE")).toBe(
      false,
    );
  });

  it("user env layer can override LICH_PROFILE (matches LICH_WORKTREE behavior)", async () => {
    // The other auto-injects allow user override (see existing test); the
    // profile name follows the same rule so behavior is consistent across
    // all three injects.
    const env = await resolveEnvForService(
      baseInput({
        profile: makeProfile({ name: "dev" }),
        config: {
          version: "1",
          owned: {
            api: { cmd: "echo", env: { LICH_PROFILE: "user-override" } },
          },
        },
      }),
    );
    expect(env.LICH_PROFILE).toBe("user-override");
  });

  it("LICH_PROFILE beats process.env so a leaked parent value can't masquerade", async () => {
    const env = await resolveEnvForService(
      baseInput({
        profile: makeProfile({ name: "dev" }),
        processEnv: { LICH_PROFILE: "leaked-from-parent" },
      }),
    );
    expect(env.LICH_PROFILE).toBe("dev");
  });
});

describe("resolveTopLevelEnv — profile layer", () => {
  it("applies profile env on top of top-level env (no per-service path here)", async () => {
    const env = await resolveTopLevelEnv({
      config: { version: "1", env: { A: "1" } },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
      profile: makeProfile({ env: { A: "2", B: "p" } }),
    });
    expect(env.A).toBe("2");
    expect(env.B).toBe("p");
  });

  it("auto-injects LICH_PROFILE for top-level resolution too", async () => {
    const env = await resolveTopLevelEnv({
      config: { version: "1" },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
      profile: makeProfile({ name: "dev:env-override" }),
    });
    expect(env.LICH_PROFILE).toBe("dev:env-override");
  });

  it("omits LICH_PROFILE when no profile is supplied", async () => {
    const env = await resolveTopLevelEnv({
      config: { version: "1" },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    expect(Object.prototype.hasOwnProperty.call(env, "LICH_PROFILE")).toBe(
      false,
    );
  });
});
