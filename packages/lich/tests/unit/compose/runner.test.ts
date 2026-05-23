import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposeCli } from "../../../src/compose/detect.js";
import {
  _exec,
  down,
  logs,
  ps,
  type ExecFn,
  type RunResult,
  type RunnerCtx,
  up,
} from "../../../src/compose/runner.js";

const DOCKER: ComposeCli = {
  kind: "docker",
  cmd: "docker",
  args: ["compose"],
};

let originalExec: ExecFn;
let recorded: Array<{
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;
let nextResult: RunResult;

beforeEach(() => {
  originalExec = _exec.current;
  recorded = [];
  nextResult = { exitCode: 0, stdout: "", stderr: "" };
  _exec.current = async (cmd, args, opts) => {
    recorded.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    return nextResult;
  };
});

afterEach(() => {
  _exec.current = originalExec;
});

/** Helper: a minimal RunnerCtx for tests. */
function ctx(overrides: Partial<RunnerCtx> = {}): RunnerCtx {
  return {
    cli: DOCKER,
    project: "lich-myrepo-abc123",
    files: ["/path/to/lich-base.yml", "/path/to/override.yml"],
    cwd: "/path/to/worktree",
    ...overrides,
  };
}

describe("up", () => {
  it("invokes `<cli> compose -p <project> -f <files...> up --detach` by default", async () => {
    await up(ctx());
    expect(recorded).toHaveLength(1);
    expect(recorded[0].cmd).toBe("docker");
    expect(recorded[0].args).toEqual([
      "compose",
      "-p",
      "lich-myrepo-abc123",
      "-f",
      "/path/to/lich-base.yml",
      "-f",
      "/path/to/override.yml",
      "up",
      "--detach",
    ]);
  });

  it("omits --detach when detach is explicitly false", async () => {
    await up(ctx(), { detach: false });
    expect(recorded[0].args).not.toContain("--detach");
    expect(recorded[0].args[recorded[0].args.length - 1]).toBe("up");
  });

  it("appends services as positional args after the up subcommand", async () => {
    await up(ctx(), { services: ["postgres", "redis"] });
    const args = recorded[0].args;
    const upIdx = args.indexOf("up");
    expect(upIdx).toBeGreaterThanOrEqual(0);
    // After `up` we expect `--detach` (default) then the services.
    expect(args.slice(upIdx)).toEqual([
      "up",
      "--detach",
      "postgres",
      "redis",
    ]);
  });

  it("passes cwd and env through to the exec function", async () => {
    const env = { FOO: "bar" };
    await up(ctx({ cwd: "/custom/cwd", env }));
    expect(recorded[0].cwd).toBe("/custom/cwd");
    expect(recorded[0].env).toEqual(env);
  });

  it("returns the captured result from the exec function", async () => {
    nextResult = { exitCode: 7, stdout: "out", stderr: "err" };
    const r = await up(ctx());
    expect(r).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
  });
});

describe("down", () => {
  it("invokes `... down` with no extra flags by default", async () => {
    await down(ctx());
    const args = recorded[0].args;
    expect(args[args.length - 1]).toBe("down");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--remove-orphans");
  });

  it("includes -v when volumes is true", async () => {
    await down(ctx(), { volumes: true });
    const args = recorded[0].args;
    expect(args).toContain("-v");
    // -v should come after `down`
    expect(args.indexOf("-v")).toBeGreaterThan(args.indexOf("down"));
  });

  it("includes --remove-orphans when remove_orphans is true", async () => {
    await down(ctx(), { remove_orphans: true });
    expect(recorded[0].args).toContain("--remove-orphans");
  });

  it("can include both -v and --remove-orphans together", async () => {
    await down(ctx(), { volumes: true, remove_orphans: true });
    expect(recorded[0].args).toContain("-v");
    expect(recorded[0].args).toContain("--remove-orphans");
  });
});

describe("ps", () => {
  it("invokes `... ps`", async () => {
    await ps(ctx());
    const args = recorded[0].args;
    expect(args[args.length - 1]).toBe("ps");
  });

  it("includes the project name and all files in the base prefix", async () => {
    await ps(ctx({ project: "lich-other-xyz", files: ["a.yml", "b.yml", "c.yml"] }));
    expect(recorded[0].args).toEqual([
      "compose",
      "-p",
      "lich-other-xyz",
      "-f",
      "a.yml",
      "-f",
      "b.yml",
      "-f",
      "c.yml",
      "ps",
    ]);
  });
});

describe("logs", () => {
  it("invokes `... logs` with no flags by default", async () => {
    await logs(ctx());
    const args = recorded[0].args;
    expect(args[args.length - 1]).toBe("logs");
    expect(args).not.toContain("--follow");
    expect(args).not.toContain("--tail");
  });

  it("includes --follow when follow is true", async () => {
    await logs(ctx(), { follow: true });
    expect(recorded[0].args).toContain("--follow");
  });

  it("includes --tail <N> when tail is provided", async () => {
    await logs(ctx(), { tail: 50 });
    const args = recorded[0].args;
    const tailIdx = args.indexOf("--tail");
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(args[tailIdx + 1]).toBe("50");
  });

  it("includes both --follow and --tail when both are provided", async () => {
    await logs(ctx(), { follow: true, tail: 50 });
    const args = recorded[0].args;
    expect(args).toContain("--follow");
    const tailIdx = args.indexOf("--tail");
    expect(args[tailIdx + 1]).toBe("50");
  });

  it("appends services as the final positional args", async () => {
    await logs(ctx(), { follow: true, tail: 100, services: ["api", "web"] });
    const args = recorded[0].args;
    // Services must come AFTER any flag/value pairs so they aren't
    // parsed as flag arguments.
    expect(args.slice(-2)).toEqual(["api", "web"]);
    const tailIdx = args.indexOf("--tail");
    expect(tailIdx).toBeLessThan(args.indexOf("api"));
  });
});

describe("CLI variants", () => {
  it("uses `podman compose` when ctx.cli is podman", async () => {
    const podman: ComposeCli = {
      kind: "podman",
      cmd: "podman",
      args: ["compose"],
    };
    await up(ctx({ cli: podman }));
    expect(recorded[0].cmd).toBe("podman");
    expect(recorded[0].args.slice(0, 1)).toEqual(["compose"]);
  });

  it("uses `nerdctl compose` when ctx.cli is nerdctl", async () => {
    const nerdctl: ComposeCli = {
      kind: "nerdctl",
      cmd: "nerdctl",
      args: ["compose"],
    };
    await up(ctx({ cli: nerdctl }));
    expect(recorded[0].cmd).toBe("nerdctl");
    expect(recorded[0].args.slice(0, 1)).toEqual(["compose"]);
  });
});
