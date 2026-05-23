import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLifecycle,
  LifecycleHookError,
  type LifecycleWarning,
} from "../../../src/lifecycle/executor.js";

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lich-lifecycle-"));
}

describe("runLifecycle", () => {
  it("before_up: runs two successful entries in order", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");

    await runLifecycle({
      phase: "before_up",
      entries: [
        `printf 'a' >> ${JSON.stringify(marker)}`,
        `printf 'b' >> ${JSON.stringify(marker)}`,
      ],
      cwd,
      env: { ...process.env },
    });

    expect(readFileSync(marker, "utf8")).toBe("ab");
  });

  it("before_up: first entry exits non-zero -> throws and stops", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "should-not-exist.txt");

    let caught: unknown;
    try {
      await runLifecycle({
        phase: "before_up",
        entries: [
          "echo 'boom' 1>&2; exit 5",
          `printf 'never' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LifecycleHookError);
    const e = caught as LifecycleHookError;
    expect(e.phase).toBe("before_up");
    expect(e.index).toBe(0);
    expect(e.exitCode).toBe(5);
    expect(e.cmd).toContain("exit 5");
    expect(e.stderr).toContain("boom");
    expect(existsSync(marker)).toBe(false);
  });

  it("after_up: failure throws LifecycleHookError with after_up phase", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runLifecycle({
        phase: "after_up",
        entries: ["echo nope 1>&2; exit 3"],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LifecycleHookError);
    const e = caught as LifecycleHookError;
    expect(e.phase).toBe("after_up");
    expect(e.exitCode).toBe(3);
    expect(e.index).toBe(0);
    expect(e.stderr).toContain("nope");
  });

  it("before_down: first entry fails, second still runs; warning emitted; no throw", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    const warnings: LifecycleWarning[] = [];

    await runLifecycle(
      {
        phase: "before_down",
        entries: [
          "echo woops 1>&2; exit 1",
          `printf 'ran' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      },
      (w) => warnings.push(w),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.index).toBe(0);
    expect(warnings[0]!.exitCode).toBe(1);
    expect(warnings[0]!.cmd).toContain("exit 1");
    expect(warnings[0]!.stderr).toContain("woops");
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });

  it("shorthand string entry runs (no env_group)", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [`printf 'shorthand' > ${JSON.stringify(marker)}`],
      cwd,
      env: { ...process.env },
    });
    expect(readFileSync(marker, "utf8")).toBe("shorthand");
  });

  it("long-form entry with cmd only (no env_group) runs", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [{ cmd: `printf 'longform' > ${JSON.stringify(marker)}` }],
      cwd,
      env: { ...process.env },
    });
    expect(readFileSync(marker, "utf8")).toBe("longform");
  });

  it("long-form entry with env_group set and no resolveEnvGroup throws", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runLifecycle({
        phase: "before_up",
        entries: [{ cmd: "true", env_group: "secrets" }],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("env_group not supported in Plan 1");
    expect((caught as Error).message).toContain("secrets");
  });

  it("long-form entry with env_group + resolveEnvGroup uses the resolved env", async () => {
    const cwd = freshTmpDir();
    let askedFor: string | null = null;

    await runLifecycle({
      phase: "before_up",
      entries: [
        { cmd: 'test "$X" = "y"', env_group: "groupA" },
      ],
      cwd,
      env: { ...process.env, X: "wrong" },
      resolveEnvGroup: async (name) => {
        askedFor = name;
        return { X: "y" };
      },
    });

    expect(askedFor).toBe("groupA");
  });

  it("env passthrough: input.env is visible to the spawned shell", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "out.txt");
    await runLifecycle({
      phase: "before_up",
      entries: [`printf '%s' "$MY" > ${JSON.stringify(marker)}`],
      cwd,
      env: { MY: "hello-env", PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(marker, "utf8")).toBe("hello-env");
  });

  it("empty entries list is a no-op", async () => {
    const cwd = freshTmpDir();
    await runLifecycle({
      phase: "before_up",
      entries: [],
      cwd,
      env: { ...process.env },
    });
    // Reaching here means no throw; no other observable side effect expected.
    expect(true).toBe(true);
  });
});
