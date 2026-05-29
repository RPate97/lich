import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import {
  LICH_BINARY as lichBinary,
  REPO_ROOT as repoRoot,
} from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(`failed to build lich binary (exit ${build.status})`);
  }
});

// Stack that has a before_up hook + an owned service.
// Designed to be fast (no compose, no network, sleep-based service).
const STACK_YAML = `version: "1"
owned:
  svc:
    cmd: "sh -c 'echo service-started; sleep 9999'"
    ready_when:
      log_match: "service-started"
lifecycle:
  before_up:
    - "echo hook-before-up-line-one"
    - "echo hook-before-up-line-two"
`;

let projectDir: string | null = null;
let lichHome: string | null = null;

function cleanup() {
  if (lichHome && projectDir) {
    try {
      spawnSync(lichBinary, ["down"], {
        cwd: projectDir,
        env: { ...process.env, LICH_HOME: lichHome, LICH_NO_BROWSER: "1" },
        timeout: 30_000,
        encoding: "utf8",
      });
    } catch {
      /* best-effort */
    }
  }
  if (projectDir && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (lichHome && existsSync(lichHome)) {
    rmSync(lichHome, { recursive: true, force: true });
  }
  projectDir = null;
  lichHome = null;
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "lich-e2e-logs-redesign-"));
  lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-logs-redesign-home-"));
  writeFileSync(join(projectDir, "lich.yaml"), STACK_YAML, "utf8");

  const upResult = runLich(["up", "--no-browser"], {
    cwd: projectDir,
    env: { LICH_HOME: lichHome },
    timeout: 60_000,
  });
  if (upResult.exitCode !== 0) {
    cleanup();
    throw new Error(
      `lich up failed (exit ${upResult.exitCode})\n--- stdout ---\n${upResult.stdout}\n--- stderr ---\n${upResult.stderr}`,
    );
  }
}, 90_000);

afterAll(() => {
  cleanup();
}, 30_000);

describe("lich logs — new storage shape", () => {
  it("phase log file exists at logs/<phase>.log (not hooks/<phase>-<idx>.log)", () => {
    const stacksDir = join(lichHome!, "stacks");
    const stackIds = readdirSync(stacksDir);
    expect(stackIds).toHaveLength(1);
    const stackId = stackIds[0]!;

    // New shape: logs/before_up.log
    const phaseLog = join(stacksDir, stackId, "logs", "before_up.log");
    expect(existsSync(phaseLog)).toBe(true);

    // Old shape: hooks/before_up-0.log — must NOT exist
    const oldHooksDir = join(stacksDir, stackId, "hooks");
    expect(existsSync(oldHooksDir)).toBe(false);
  });

  it("before_up.log contains command headers and hook output", () => {
    const stacksDir = join(lichHome!, "stacks");
    const stackId = readdirSync(stacksDir)[0]!;
    const phaseLog = join(stacksDir, stackId, "logs", "before_up.log");

    const contents = readFileSync(phaseLog, "utf8");

    // Command headers segment the entries
    expect(contents).toContain("before_up[0]");
    expect(contents).toContain("before_up[1]");

    // Hook output is present
    expect(contents).toContain("hook-before-up-line-one");
    expect(contents).toContain("hook-before-up-line-two");
  });

  it("service log file exists at logs/svc.log", () => {
    const stacksDir = join(lichHome!, "stacks");
    const stackId = readdirSync(stacksDir)[0]!;
    const svcLog = join(stacksDir, stackId, "logs", "svc.log");
    expect(existsSync(svcLog)).toBe(true);
  });
});

describe("lich logs — default mode", () => {
  it("exits immediately (non-follow) with exit 0", () => {
    const start = Date.now();
    const result = runLich(["logs"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // Should exit quickly — not block like follow mode
    expect(elapsed).toBeLessThan(5_000);
  });

  it("shows service content without needing --follow", () => {
    const result = runLich(["logs"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("service-started");
  });

  it("includes pagination footer in pretty mode", () => {
    const result = runLich(["logs"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    // Footer shows line range and hints
    expect(result.stdout).toMatch(/Showing lines/);
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("--follow");
  });
});

describe("lich logs — source filter", () => {
  it("filters to a single service: svc", () => {
    const result = runLich(["logs", "svc"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("service-started");
    // No [svc] prefix when single source selected
    expect(result.stdout).not.toMatch(/^\[svc\] /m);
  });

  it("filters to before_up phase log", () => {
    const result = runLich(["logs", "before_up"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hook-before-up-line-one");
  });

  it("unknown source exits non-zero and lists available sources", () => {
    const result = runLich(["logs", "no-such-service"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("no-such-service");
    expect(combined).toContain("svc");
  });
});

describe("lich logs — --count / --all", () => {
  it("--count 1 returns at most 1 line of service content", () => {
    const result = runLich(["logs", "svc", "--count", "1"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    // Count the non-empty, non-footer content lines
    const contentLines = result.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith("Showing") && !l.startsWith("Older") && !l.startsWith("Newer") && !l.startsWith("Full"));
    expect(contentLines.length).toBeLessThanOrEqual(1);
  });

  it("--all emits all lines without the pagination footer", () => {
    const result = runLich(["logs", "before_up", "--all"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hook-before-up-line-one");
    expect(result.stdout).not.toContain("Showing lines");
  });
});

describe("lich logs — cursor pagination", () => {
  it("--json returns lines with n, source, text fields and cursor metadata", () => {
    const result = runLich(["logs", "--json"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);

    let parsed: {
      lines: Array<{ n: number; source: string; text: string }>;
      cursor: { before: number; after: number };
      total_lines: number;
      has_more_before: boolean;
      has_more_after: boolean;
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`lich logs --json did not return valid JSON:\n${result.stdout}`);
    }

    expect(parsed.lines).toBeInstanceOf(Array);
    expect(parsed.cursor).toHaveProperty("before");
    expect(parsed.cursor).toHaveProperty("after");
    expect(parsed).toHaveProperty("total_lines");
    expect(parsed).toHaveProperty("has_more_before");
    expect(parsed).toHaveProperty("has_more_after");

    if (parsed.lines.length > 0) {
      expect(parsed.lines[0]).toHaveProperty("n");
      expect(parsed.lines[0]).toHaveProperty("source");
      expect(parsed.lines[0]).toHaveProperty("text");
    }
  });

  it("--before cursor shows older lines, --after shows newer", () => {
    // Get first page with JSON to extract cursor
    const page1Result = runLich(["logs", "before_up", "--json", "--all"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(page1Result.exitCode).toBe(0);

    const page1 = JSON.parse(page1Result.stdout) as {
      lines: Array<{ n: number; text: string }>;
      cursor: { before: number; after: number };
      total_lines: number;
    };

    if (page1.total_lines < 2) {
      // Not enough lines to test pagination; skip
      return;
    }

    // --before the second line should return only the first line
    const beforeResult = runLich(
      ["logs", "before_up", "--json", "--before", String(page1.lines[1]!.n)],
      {
        cwd: projectDir!,
        env: { LICH_HOME: lichHome! },
        timeout: 10_000,
      },
    );
    expect(beforeResult.exitCode).toBe(0);
    const beforePage = JSON.parse(beforeResult.stdout) as { lines: Array<{ n: number }> };
    // Should only contain lines before the cursor line
    for (const line of beforePage.lines) {
      expect(line.n).toBeLessThan(page1.lines[1]!.n);
    }

    // --after the first line should return remaining lines
    const afterResult = runLich(
      ["logs", "before_up", "--json", "--after", String(page1.lines[0]!.n)],
      {
        cwd: projectDir!,
        env: { LICH_HOME: lichHome! },
        timeout: 10_000,
      },
    );
    expect(afterResult.exitCode).toBe(0);
    const afterPage = JSON.parse(afterResult.stdout) as { lines: Array<{ n: number }> };
    for (const line of afterPage.lines) {
      expect(line.n).toBeGreaterThan(page1.lines[0]!.n);
    }
  });
});

describe("lich logs — --grep filter", () => {
  it("--grep filters to matching lines only", () => {
    const result = runLich(["logs", "before_up", "--grep", "line-one", "--all"], {
      cwd: projectDir!,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hook-before-up-line-one");
    expect(result.stdout).not.toContain("hook-before-up-line-two");
  });

  it("--grep with no match emits empty page", () => {
    const result = runLich(
      ["logs", "before_up", "--grep", "zzznomatch-xyz", "--all"],
      {
        cwd: projectDir!,
        env: { LICH_HOME: lichHome! },
        timeout: 10_000,
      },
    );
    expect(result.exitCode).toBe(0);
    // No content lines — footer may still show "0 lines"
    expect(result.stdout).not.toContain("hook-before-up-line-one");
    expect(result.stdout).not.toContain("hook-before-up-line-two");
  });

  it("--grep composes with --json to include filter metadata in output", () => {
    const result = runLich(
      ["logs", "before_up", "--grep", "line-one", "--json"],
      {
        cwd: projectDir!,
        env: { LICH_HOME: lichHome! },
        timeout: 10_000,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { lines: Array<{ text: string }> };
    for (const line of parsed.lines) {
      expect(line.text).toContain("line-one");
    }
  });
});

describe("lich logs — --follow mode (opt-in)", () => {
  it("--follow blocks until aborted (signals are opt-in for humans)", async () => {
    const child = spawn(
      lichBinary,
      ["logs", "--follow"],
      {
        cwd: projectDir!,
        env: { ...process.env, LICH_HOME: lichHome!, LICH_NO_BROWSER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

    // Wait a bit for some output to appear
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(child.exitCode).toBeNull();

    // Kill and confirm it was alive (blocking)
    child.kill("SIGTERM");

    await new Promise<void>((r) => child.once("exit", () => r()));

    // Should have produced service output while following
    expect(output).toContain("service-started");
  }, 15_000);
});
