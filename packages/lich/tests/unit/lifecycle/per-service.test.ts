import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPerServiceLifecycle,
  PerServiceLifecycleError,
  type PerServiceLifecycleWarning,
} from "../../../src/lifecycle/per-service.js";

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lich-per-service-lifecycle-"));
}

describe("runPerServiceLifecycle", () => {
  it("before_start: runs two successful entries in order", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");

    await runPerServiceLifecycle({
      serviceName: "api",
      phase: "before_start",
      entries: [
        `printf 'a' >> ${JSON.stringify(marker)}`,
        `printf 'b' >> ${JSON.stringify(marker)}`,
      ],
      cwd,
      env: { ...process.env },
    });

    expect(readFileSync(marker, "utf8")).toBe("ab");
  });

  it("before_start: first entry exits non-zero -> throws PerServiceLifecycleError and stops", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "should-not-exist.txt");

    let caught: unknown;
    try {
      await runPerServiceLifecycle({
        serviceName: "api",
        phase: "before_start",
        entries: [
          "echo 'boom' 1>&2; exit 3",
          `printf 'never' > ${JSON.stringify(marker)}`,
        ],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PerServiceLifecycleError);
    const e = caught as PerServiceLifecycleError;
    expect(e.serviceName).toBe("api");
    expect(e.phase).toBe("before_start");
    expect(e.index).toBe(0);
    expect(e.exitCode).toBe(3);
    expect(e.cmd).toContain("exit 3");
    expect(e.stderr).toContain("boom");
    // Error message carries serviceName + phase + index for human readability
    expect(e.message).toContain("api");
    expect(e.message).toContain("before_start");
    expect(e.message).toContain("#0");
    // Second entry never ran
    expect(existsSync(marker)).toBe(false);
  });

  it("after_ready: failure throws PerServiceLifecycleError with after_ready phase", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runPerServiceLifecycle({
        serviceName: "web",
        phase: "after_ready",
        entries: ["echo nope 1>&2; exit 7"],
        cwd,
        env: { ...process.env },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PerServiceLifecycleError);
    const e = caught as PerServiceLifecycleError;
    expect(e.serviceName).toBe("web");
    expect(e.phase).toBe("after_ready");
    expect(e.index).toBe(0);
    expect(e.exitCode).toBe(7);
    expect(e.stderr).toContain("nope");
  });

  it("before_down: first entry fails, second still runs; warning emitted; no throw", async () => {
    const cwd = freshTmpDir();
    const marker = join(cwd, "marker.txt");
    const warnings: PerServiceLifecycleWarning[] = [];

    await runPerServiceLifecycle(
      {
        serviceName: "worker",
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
    expect(warnings[0]!.serviceName).toBe("worker");
    expect(warnings[0]!.phase).toBe("before_down");
    expect(warnings[0]!.index).toBe(0);
    expect(warnings[0]!.exitCode).toBe(1);
    expect(warnings[0]!.cmd).toContain("exit 1");
    expect(warnings[0]!.stderr).toContain("woops");
    // Second entry ran despite first failing
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });

  it("long-form entry with env_group set and no resolveEnvGroup throws with 'env_group not supported in Plan 1'", async () => {
    const cwd = freshTmpDir();
    let caught: unknown;
    try {
      await runPerServiceLifecycle({
        serviceName: "api",
        phase: "before_start",
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
    expect((caught as Error).message).toContain("api");
  });

  it("long-form entry with env_group + resolveEnvGroup uses the resolved env (X=y)", async () => {
    const cwd = freshTmpDir();
    let askedFor: string | null = null;

    // If resolveEnvGroup wasn't used, the inherited X=wrong would make the test
    // fail with exit 1 -> PerServiceLifecycleError. Passing means X=y was used.
    await runPerServiceLifecycle({
      serviceName: "api",
      phase: "before_start",
      entries: [
        { cmd: '[ "$X" = "y" ]', env_group: "groupA" },
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

  it("env passthrough: input.env={MY:'val'} is visible to the spawned shell", async () => {
    const cwd = freshTmpDir();
    // The shell test `[ "$MY" = "val" ]` exits 0 only if MY=val. Any other
    // value exits 1 -> PerServiceLifecycleError -> test fails.
    await runPerServiceLifecycle({
      serviceName: "api",
      phase: "before_start",
      entries: [`[ "$MY" = "val" ]`],
      cwd,
      env: { MY: "val", PATH: process.env.PATH ?? "" },
    });
    // Reaching here means the entry exited 0 and saw MY=val.
    expect(true).toBe(true);
  });

  it("empty entries list is a no-op", async () => {
    const cwd = freshTmpDir();
    await runPerServiceLifecycle({
      serviceName: "api",
      phase: "before_start",
      entries: [],
      cwd,
      env: { ...process.env },
    });
    expect(true).toBe(true);
  });

  it("before_down with no warning callback does not throw on failure", async () => {
    const cwd = freshTmpDir();
    // No onWarning passed; failure must still be silently swallowed.
    await runPerServiceLifecycle({
      serviceName: "api",
      phase: "before_down",
      entries: ["exit 9"],
      cwd,
      env: { ...process.env },
    });
    expect(true).toBe(true);
  });
});
