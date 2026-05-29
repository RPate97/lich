import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(__dirname, "../../..");
const lichBinary = resolve(packageRoot, "dist/lich");

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  if (!existsSync(lichBinary)) {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(
        `failed to build lich binary: ${build.stderr || build.stdout}`,
      );
    }
  }
  if (!existsSync(lichBinary)) {
    throw new Error(`lich binary still missing at ${lichBinary}`);
  }
});

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-dispatch-home-"));
  // `stack-` prefix so detectWorktree derives a clean name from the basename
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLich(args: string[]): RunResult {
  const result = spawnSync(lichBinary, args, {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("bin/lich.ts — dispatch integration", () => {
  it("falls through to user-command dispatch when name is not a built-in", () => {
    writeYaml(`
version: "1"
commands:
  greet:
    cmd: 'echo "hello from user command"'
`);

    const result = runLich(["greet"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello from user command");
  });

  it("forwards the user command's exit code (non-zero)", () => {
    writeYaml(`
version: "1"
commands:
  fail:
    cmd: 'exit 42'
`);

    const result = runLich(["fail"]);

    expect(result.status).toBe(42);
  });

  it("forwards extra argv to the user command via $@", () => {
    writeYaml(`
version: "1"
commands:
  echo-args:
    cmd: 'echo "$@"'
`);

    const result = runLich(["echo-args", "alpha", "beta"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("alpha beta");
  });
});

describe("bin/lich.ts — --env-group override", () => {
  it("parses --env-group=X and forwards to dispatcher", () => {
    writeYaml(`
version: "1"
env_groups:
  groupA:
    env:
      MY_VAR: "value-A"
  groupB:
    env:
      MY_VAR: "value-B"
commands:
  show:
    cmd: 'printenv MY_VAR'
    env_group: groupA
`);

    const baseline = runLich(["show"]);
    expect(baseline.status).toBe(0);
    expect(baseline.stdout.trim()).toBe("value-A");

    const overridden = runLich(["show", "--env-group=groupB"]);
    expect(overridden.status).toBe(0);
    expect(overridden.stdout.trim()).toBe("value-B");
  });

  it("accepts the space-separated form (--env-group X)", () => {
    writeYaml(`
version: "1"
env_groups:
  custom:
    env:
      MY_VAR: "spaced-form-value"
commands:
  show:
    cmd: 'printenv MY_VAR'
`);

    const result = runLich(["show", "--env-group", "custom"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("spaced-form-value");
  });
});

describe("bin/lich.ts — unknown command handling", () => {
  it("prints 'unknown command' when neither built-in nor user command", () => {
    writeYaml(`
version: "1"
commands:
  greet:
    cmd: 'echo hi'
`);

    const result = runLich(["totally-not-a-command"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("totally-not-a-command");
    expect(result.stderr.toLowerCase()).toContain("lich --help");
  });

  it("prints 'unknown command' when no lich.yaml is present", () => {
    const result = runLich(["random-name"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("random-name");
  });

  it("returns 2 when config parse fails (yaml syntax error)", () => {
    writeFileSync(
      join(projectDir, "lich.yaml"),
      "version: \"1\"\ncommands: { broken-here\n",
      "utf8",
    );

    const result = runLich(["whatever"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });

  it("returns 2 when commands: section is absent entirely", () => {
    writeYaml(`version: "1"`);

    const result = runLich(["any-name"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command");
  });
});

describe("bin/lich.ts — built-in commands keep working alongside dispatch", () => {
  it("built-in name wins over a user command of the same name (no shadowing path)", () => {
    writeYaml(`
version: "1"
commands:
  stacks:
    cmd: 'echo "user stacks should never run"'
`);

    const result = runLich(["stacks"]);

    expect(result.stdout).not.toContain("user stacks should never run");
  });

  it("--env-group=X is ignored by built-ins that don't read it", () => {
    const result = runLich(["stacks", "--env-group=anything"]);

    expect(result.status).toBe(0);
  });
});
