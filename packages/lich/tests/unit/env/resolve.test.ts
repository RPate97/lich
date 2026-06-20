import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveEnvForService,
  resolveSharedEnvBase,
  resolveTopLevelEnv,
  type ResolveEnvForServiceInput,
} from "../../../src/env/resolve.js";
import type { LichConfig } from "../../../src/config/types.js";
import type { ResolvedProfile } from "../../../src/profiles/resolve.js";
import type { Worktree } from "../../../src/worktree/detect.js";

let tmp: string;

beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so paths compare cleanly
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
  main_path: "/tmp/feature-x",
};

function baseInput(
  overrides: Partial<ResolveEnvForServiceInput> = {},
): ResolveEnvForServiceInput {
  return {
    config: { version: "1" },
    service: { kind: "owned", name: "api" },
    worktree,
    allocatedPorts: { compose: {}, owned: {} },
    processEnv: {},
    projectRoot: tmp,
    ...overrides,
  };
}

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

describe("resolveEnvForService — env_files fallback to main worktree", () => {
  let mainTmp: string;
  let worktreeTmp: string;
  beforeEach(() => {
    mainTmp = mkdtempSync(path.join(os.tmpdir(), "lich-env-main-"));
    worktreeTmp = mkdtempSync(path.join(os.tmpdir(), "lich-env-wt-"));
  });
  afterEach(() => {
    rmSync(mainTmp, { recursive: true, force: true });
    rmSync(worktreeTmp, { recursive: true, force: true });
  });

  it("loads from the main worktree when the file does not exist in the current worktree", async () => {
    writeFileSync(path.join(mainTmp, ".env"), "FROM_MAIN=yes\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        projectRootFallback: mainTmp,
        config: { version: "1", env_files: [".env"] },
      }),
    );
    expect(env.FROM_MAIN).toBe("yes");
  });

  it("current worktree wins when the file exists in both places", async () => {
    writeFileSync(path.join(mainTmp, ".env"), "VAL=from-main\n", "utf8");
    writeFileSync(path.join(worktreeTmp, ".env"), "VAL=from-worktree\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        projectRootFallback: mainTmp,
        config: { version: "1", env_files: [".env"] },
      }),
    );
    expect(env.VAL).toBe("from-worktree");
  });

  it("merges entries: shared .env from main, worktree-specific .env.local from current", async () => {
    writeFileSync(path.join(mainTmp, ".env"), "BASE=from-main\n", "utf8");
    writeFileSync(path.join(worktreeTmp, ".env.local"), "WT=local-override\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        projectRootFallback: mainTmp,
        config: { version: "1", env_files: [".env", ".env.local"] },
      }),
    );
    expect(env.BASE).toBe("from-main");
    expect(env.WT).toBe("local-override");
  });

  it("absolute env_files paths ignore the fallback", async () => {
    const absFile = path.join(mainTmp, "outside.env");
    writeFileSync(absFile, "ABS=absolute\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        projectRootFallback: mainTmp,
        config: { version: "1", env_files: [absFile] },
      }),
    );
    expect(env.ABS).toBe("absolute");
  });

  it("no fallback applied when projectRoot === projectRootFallback (main worktree case)", async () => {
    writeFileSync(path.join(worktreeTmp, ".env"), "OK=yes\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        projectRootFallback: worktreeTmp,
        config: { version: "1", env_files: [".env"] },
      }),
    );
    expect(env.OK).toBe("yes");
  });

  it("derives fallback from worktree.main_path when projectRootFallback is omitted", async () => {
    writeFileSync(path.join(mainTmp, ".env"), "DERIVED=ok\n", "utf8");
    const env = await resolveEnvForService(
      baseInput({
        projectRoot: worktreeTmp,
        worktree: { ...worktree, path: worktreeTmp, main_path: mainTmp },
        config: { version: "1", env_files: [".env"] },
      }),
    );
    expect(env.DERIVED).toBe("ok");
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
        // per-service block must be ignored by resolveTopLevelEnv
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

describe("resolveEnvForService — profile layer", () => {
  it("applies profile env layer between top-level and per-service", async () => {
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

// lazy-per-key: a value replaced by a higher layer never reaches the interpolation engine
describe("resolveEnvForService — lazy-per-key interpolation", () => {
  it("does NOT interpolate a top-level value that a profile layer overrides", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: {
            DATABASE_URL:
              "postgresql://localhost:${owned.supabase.ports.db}/x",
          },
        },
        profile: makeProfile({
          env: { DATABASE_URL: "postgresql://hosted.example.com:5432/x" },
        }),
        // No owned.supabase in the ports map.
        allocatedPorts: { compose: {}, owned: {} },
      }),
    );
    expect(env.DATABASE_URL).toBe(
      "postgresql://hosted.example.com:5432/x",
    );
  });

  it("DOES interpolate (and throws) the same top-level value when nothing overrides it", async () => {
    await expect(
      resolveEnvForService(
        baseInput({
          config: {
            version: "1",
            env: {
              DATABASE_URL:
                "postgresql://localhost:${owned.supabase.ports.db}/x",
            },
          },
          allocatedPorts: { compose: {}, owned: {} },
        }),
      ),
    ).rejects.toThrow(
      /supabase|no owned service named "supabase"|owned.*supabase.*ports/i,
    );
  });

  it("per-service env override prevents interpolation of overridden top-level value", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: {
            DATABASE_URL:
              "postgresql://localhost:${owned.supabase.ports.db}/x",
          },
          owned: {
            api: {
              cmd: "echo",
              env: { DATABASE_URL: "postgresql://override.example.com/x" },
            },
          },
        },
        allocatedPorts: { compose: {}, owned: {} },
      }),
    );
    expect(env.DATABASE_URL).toBe("postgresql://override.example.com/x");
  });

  it("profile-layer override of an env_files value also short-circuits interpolation", async () => {
    write(
      ".env",
      "DATABASE_URL=postgres://localhost:${owned.supabase.ports.db}/x\n",
    );
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env_files: [".env"] },
        profile: makeProfile({
          env: { DATABASE_URL: "postgresql://hosted.example.com:5432/x" },
        }),
        allocatedPorts: { compose: {}, owned: {} },
      }),
    );
    expect(env.DATABASE_URL).toBe(
      "postgresql://hosted.example.com:5432/x",
    );
  });

  it("a profile-layer reference to a service IN the profile is resolved normally", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { DATABASE_URL: "should-be-overridden" },
        },
        profile: makeProfile({
          env: {
            DATABASE_URL: "postgres://localhost:${owned.api.port}/x",
          },
        }),
        allocatedPorts: {
          compose: {},
          owned: { api: { port: 12345 } },
        },
      }),
    );
    expect(env.DATABASE_URL).toBe("postgres://localhost:12345/x");
  });

  it("a value with multiple ${...} refs throws when ANY of them is unresolvable", async () => {
    // lazy-per-key skips overridden values, not partial-failure values
    await expect(
      resolveEnvForService(
        baseInput({
          config: {
            version: "1",
            env: {
              MIXED:
                "api=${owned.api.port};missing=${owned.supabase.ports.db}",
            },
          },
          allocatedPorts: {
            compose: {},
            owned: { api: { port: 7000 } },
          },
        }),
      ),
    ).rejects.toThrow(/supabase|owned.*supabase.*ports/i);
  });
});

describe("resolveTopLevelEnv — lazy-per-key interpolation", () => {
  it("does NOT interpolate a top-level value that a profile layer overrides", async () => {
    const env = await resolveTopLevelEnv({
      config: {
        version: "1",
        env: {
          DATABASE_URL:
            "postgresql://localhost:${owned.supabase.ports.db}/x",
        },
      },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
      profile: makeProfile({
        env: { DATABASE_URL: "postgresql://hosted.example.com:5432/x" },
      }),
    });
    expect(env.DATABASE_URL).toBe(
      "postgresql://hosted.example.com:5432/x",
    );
  });

  it("DOES interpolate (and throws) the top-level value when no profile override exists", async () => {
    await expect(
      resolveTopLevelEnv({
        config: {
          version: "1",
          env: {
            DATABASE_URL:
              "postgresql://localhost:${owned.supabase.ports.db}/x",
          },
        },
        worktree,
        allocatedPorts: { compose: {}, owned: {} },
        processEnv: {},
        projectRoot: tmp,
      }),
    ).rejects.toThrow(
      /supabase|no owned service named "supabase"|owned.*supabase.*ports/i,
    );
  });
});

// `env: { VAR: null }` is the explicit-unset sentinel — distinct from empty string
describe("resolveEnvForService — env: { VAR: null } unsets", () => {
  it("top-level env null beats parent process.env and removes the key", async () => {
    const env = await resolveEnvForService(
      baseInput({
        processEnv: { CANARY: "from-parent", KEEP: "still-here" },
        config: { version: "1", env: { CANARY: null } },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "CANARY")).toBe(false);
    expect(env.KEEP).toBe("still-here");
  });

  it("per-service env null overrides a top-level env value for that service only", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { FOO: "top-value" },
          owned: {
            api: { cmd: "echo", env: { FOO: null } },
          },
        },
        service: { kind: "owned", name: "api" },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });

  it("per-service env null only affects the targeted service (siblings keep the top-level value)", async () => {
    const config = {
      version: "1",
      env: { FOO: "top-value" },
      owned: {
        api: { cmd: "echo", env: { FOO: null } },
        web: { cmd: "echo" },
      },
    } as const;

    const apiEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "api" }, config }),
    );
    expect(Object.prototype.hasOwnProperty.call(apiEnv, "FOO")).toBe(false);

    const webEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "web" }, config }),
    );
    expect(webEnv.FOO).toBe("top-value");
  });

  it("env literal null overrides a same-layer env_from value", async () => {
    // within-layer precedence: env_from < env_files < env literals
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "BAZ=from-shell"'],
          env: { BAZ: null },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "BAZ")).toBe(false);
  });

  it("profile env null overrides top-level env value", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { DATABASE_URL: "postgres://top" },
        },
        profile: makeProfile({ env: { DATABASE_URL: null } }),
      }),
    );
    expect(
      Object.prototype.hasOwnProperty.call(env, "DATABASE_URL"),
    ).toBe(false);
  });

  it("per-service env null overrides a profile env value", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          owned: { api: { cmd: "echo", env: { FOO: null } } },
        },
        profile: makeProfile({ env: { FOO: "profile-value" } }),
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });

  it("null does NOT remove auto-injected LICH_WORKTREE (auto-inject layer is below user env)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: { version: "1", env: { OTHER: null } },
      }),
    );
    expect(env.LICH_WORKTREE).toBe("feature-x");
  });

  it("a later env null beats parent process.env even when the env layer is empty otherwise", async () => {
    // Mirrors `unset VAR` in bash — null in lich.yaml beats parent env
    const env = await resolveEnvForService(
      baseInput({
        processEnv: {
          NEXT_PUBLIC_AUTH_SUPABASE_URL: "https://prod.example.com",
        },
        config: {
          version: "1",
          env: { NEXT_PUBLIC_AUTH_SUPABASE_URL: null },
        },
      }),
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        env,
        "NEXT_PUBLIC_AUTH_SUPABASE_URL",
      ),
    ).toBe(false);
  });

  it("null in a value that would interpolate to a missing ref does NOT raise (drop wins over interpolation)", async () => {
    // unset drop runs BEFORE interpolation
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { FOO: null },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });

  it("a value that points at a missing service is dropped (no interp error) when a later layer nulls it", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env: { BAD: "${owned.missing.port}" },
          owned: { api: { cmd: "echo", env: { BAD: null } } },
        },
        allocatedPorts: { compose: {}, owned: {} },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "BAD")).toBe(false);
  });

  it("env_from cmd does NOT see prior-layer null values stringified as 'null'", async () => {
    // Node spawn coerces null env values to "null" string — must strip before
    // passing baseEnv to loadEnvFromShellOut, else child sees "FOO=null"
    const env = await resolveEnvForService(
      baseInput({
        processEnv: { FOO: "from-parent" },
        config: {
          version: "1",
          env: { FOO: null },
          owned: {
            api: {
              cmd: "echo",
              env_from: ['printenv FOO > /dev/null && echo "PROBE=present" || echo "PROBE=MISSING"'],
            },
          },
        },
      }),
    );
    expect(env.PROBE).toBe("MISSING");
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });
});

describe("resolveTopLevelEnv — env: { VAR: null } unsets", () => {
  it("top-level env null removes the key from the top-level resolution", async () => {
    const env = await resolveTopLevelEnv({
      config: {
        version: "1",
        env: { FOO: "x", BAR: null },
      },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: { BAR: "from-parent" },
      projectRoot: tmp,
    });
    expect(env.FOO).toBe("x");
    expect(Object.prototype.hasOwnProperty.call(env, "BAR")).toBe(false);
  });

  it("profile env null removes a top-level value at the top-level resolution surface", async () => {
    const env = await resolveTopLevelEnv({
      config: { version: "1", env: { FOO: "top-value" } },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
      profile: makeProfile({ env: { FOO: null } }),
    });
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });

  it("a nulled value with an unresolvable interpolation does NOT throw", async () => {
    const env = await resolveTopLevelEnv({
      config: {
        version: "1",
        env: {
          DATABASE_URL:
            "postgresql://localhost:${owned.supabase.ports.db}/x",
        },
      },
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
      profile: makeProfile({ env: { DATABASE_URL: null } }),
    });
    expect(
      Object.prototype.hasOwnProperty.call(env, "DATABASE_URL"),
    ).toBe(false);
  });
});

describe("resolveEnvForService — per-service env_from", () => {
  it("per-service env_from overrides top-level env_from on key collision (per-service wins)", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "FOO=1"'],
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "FOO=2"'],
            },
          },
        },
      }),
    );
    expect(env.FOO).toBe("2");
  });

  it("disjoint keys from top-level and per-service env_from both appear in resolved env", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "SHARED=top"'],
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "SCOPED=local"'],
            },
          },
        },
      }),
    );
    expect(env.SHARED).toBe("top");
    expect(env.SCOPED).toBe("local");
  });

  it("sibling owned service WITHOUT per-service env_from sees only top-level vars", async () => {
    // isolation: scoped vars must not leak across services (security footgun)
    const config = {
      version: "1",
      env_from: ['echo "SHARED=top"'],
      owned: {
        api: {
          cmd: "echo",
          env_from: ['echo "API_SCOPED=api-only"'],
        },
        web: {
          cmd: "echo",
        },
      },
    } as const;

    const apiEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "api" }, config }),
    );
    expect(apiEnv.SHARED).toBe("top");
    expect(apiEnv.API_SCOPED).toBe("api-only");

    const webEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "web" }, config }),
    );
    expect(webEnv.SHARED).toBe("top");
    expect(
      Object.prototype.hasOwnProperty.call(webEnv, "API_SCOPED"),
    ).toBe(false);
  });

  it("per-service env_from with sibling-only paths produces distinct envs for each service", async () => {
    const config = {
      version: "1",
      owned: {
        web: {
          cmd: "echo",
          env_from: ['echo "WEB_SECRET=web-value"'],
        },
        server: {
          cmd: "echo",
          env_from: ['echo "SERVER_SECRET=server-value"'],
        },
      },
    } as const;

    const webEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "web" }, config }),
    );
    expect(webEnv.WEB_SECRET).toBe("web-value");
    expect(
      Object.prototype.hasOwnProperty.call(webEnv, "SERVER_SECRET"),
    ).toBe(false);

    const serverEnv = await resolveEnvForService(
      baseInput({ service: { kind: "owned", name: "server" }, config }),
    );
    expect(serverEnv.SERVER_SECRET).toBe("server-value");
    expect(
      Object.prototype.hasOwnProperty.call(serverEnv, "WEB_SECRET"),
    ).toBe(false);
  });

  it("per-service env literal null unsets a value set by per-service env_from", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "SECRET=from-shell"'],
              env: { SECRET: null },
            },
          },
        },
      }),
    );
    expect(
      Object.prototype.hasOwnProperty.call(env, "SECRET"),
    ).toBe(false);
  });

  it("per-service env literal null unsets a value set by top-level env_from", async () => {
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "FOO=from-top-shell"'],
          owned: {
            api: {
              cmd: "echo",
              env: { FOO: null },
            },
          },
        },
      }),
    );
    expect(Object.prototype.hasOwnProperty.call(env, "FOO")).toBe(false);
  });

  it("per-service env_from sees the top-level merged env (can chain off top-level secrets)", async () => {
    // baseEnv threading: per-service shell-out can read top-level env_from output
    const env = await resolveEnvForService(
      baseInput({
        config: {
          version: "1",
          env_from: ['echo "AUTH_TOKEN=tk-123"'],
          owned: {
            api: {
              cmd: "echo",
              env_from: [
                'printf "CHAINED=%s\\n" "$AUTH_TOKEN"',
              ],
            },
          },
        },
      }),
    );
    expect(env.AUTH_TOKEN).toBe("tk-123");
    expect(env.CHAINED).toBe("tk-123");
  });

  it("compose-kind service gets only top-level env_from (per-service layer is a no-op for compose)", async () => {
    // compose owns its own environment: block on the compose side
    const env = await resolveEnvForService(
      baseInput({
        service: { kind: "compose", name: "web" },
        config: {
          version: "1",
          env_from: ['echo "TOP_SHARED=yes"'],
          services: { web: { image: "nginx" } },
          // wrong kind for resolved service — must not apply
          owned: {
            api: {
              cmd: "echo",
              env_from: ['echo "OWNED_SCOPED=should-not-leak"'],
            },
          },
        },
      }),
    );
    expect(env.TOP_SHARED).toBe("yes");
    expect(
      Object.prototype.hasOwnProperty.call(env, "OWNED_SCOPED"),
    ).toBe(false);
  });
});

describe("resolveSharedEnvBase — shared base reuse", () => {
  function countingFrom(file: string, kv: string): string {
    return `echo ran >> '${file}'; echo "${kv}"`;
  }

  function runCount(file: string): number {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return 0;
    }
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  }

  it("threading baseEnv runs top-level env_from exactly once across services", async () => {
    const counter = path.join(tmp, "top-count.log");
    const config: LichConfig = {
      version: "1",
      env_from: [countingFrom(counter, "SHARED=top")],
      owned: {
        api: { cmd: "echo", env: { A: "1" } },
        web: { cmd: "echo", env: { B: "2" } },
      },
    };

    const base = await resolveSharedEnvBase({
      config,
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    const apiEnv = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "api" }, baseEnv: base }),
    );
    const webEnv = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "web" }, baseEnv: base }),
    );

    expect(runCount(counter)).toBe(1);
    expect(apiEnv.SHARED).toBe("top");
    expect(apiEnv.A).toBe("1");
    expect(webEnv.SHARED).toBe("top");
    expect(webEnv.B).toBe("2");
  });

  it("baseEnv threading yields the same env as resolving the service standalone", async () => {
    const config: LichConfig = {
      version: "1",
      env: { TOP: "t" },
      env_from: ['echo "FROM_TOP=shell"'],
      owned: {
        api: { cmd: "echo", env: { OWN: "o" }, env_from: ['echo "FROM_SVC=svc"'] },
      },
    };
    const standalone = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "api" } }),
    );
    const base = await resolveSharedEnvBase({
      config,
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    const viaBase = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "api" }, baseEnv: base }),
    );
    expect(viaBase).toEqual(standalone);
  });

  it("per-service env_from still runs when a base is threaded", async () => {
    const counter = path.join(tmp, "svc-count.log");
    const config: LichConfig = {
      version: "1",
      owned: {
        api: { cmd: "echo", env_from: [countingFrom(counter, "SVC=1")] },
      },
    };
    const base = await resolveSharedEnvBase({
      config,
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    const env = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "api" }, baseEnv: base }),
    );
    expect(env.SVC).toBe("1");
    expect(runCount(counter)).toBe(1);
  });

  it("per-service layering does not mutate the shared base (no cross-service leak)", async () => {
    const config: LichConfig = {
      version: "1",
      env: { SHARED: "top" },
      owned: {
        api: { cmd: "echo", env: { ONLY_API: "a" } },
        web: { cmd: "echo", env: { ONLY_WEB: "w" } },
      },
    };
    const base = await resolveSharedEnvBase({
      config,
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    const apiEnv = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "api" }, baseEnv: base }),
    );
    const webEnv = await resolveEnvForService(
      baseInput({ config, service: { kind: "owned", name: "web" }, baseEnv: base }),
    );
    expect(apiEnv.ONLY_API).toBe("a");
    expect(apiEnv.ONLY_WEB).toBeUndefined();
    expect(webEnv.ONLY_WEB).toBe("w");
    expect(webEnv.ONLY_API).toBeUndefined();
  });

  it("base is pre-interpolation: a top-level literal with a capture resolves per-service", async () => {
    const config: LichConfig = {
      version: "1",
      env: { DB: "${owned.pg.captured.url}" },
      owned: { api: { cmd: "echo" } },
    };
    const base = await resolveSharedEnvBase({
      config,
      worktree,
      allocatedPorts: { compose: {}, owned: {} },
      processEnv: {},
      projectRoot: tmp,
    });
    const env = await resolveEnvForService(
      baseInput({
        config,
        service: { kind: "owned", name: "api" },
        baseEnv: base,
        capturedValues: { pg: { url: "postgres://x" } },
      }),
    );
    expect(env.DB).toBe("postgres://x");
  });
});
