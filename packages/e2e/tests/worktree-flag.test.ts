import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

// Two dogfood-stack copies brought up under one shared LICH_HOME — exercises
// the new --worktree flag (LEV-526) which lets logs/urls/exec/env/down/restart/routing
// target a stack outside the cwd.

interface StackCopy {
  path: string;
  cleanup: () => void;
}

let lichHome: string | null = null;
let stackA: StackCopy | null = null;
let stackB: StackCopy | null = null;
let stackIdA: string | null = null;
let stackIdB: string | null = null;
let worktreeNameA: string | null = null;
let worktreeNameB: string | null = null;

function lichUp(cwd: string): ReturnType<typeof runLich> {
  return runLich(["up", "dev:fast", "--no-browser"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    timeout: 180_000,
  });
}

function lichDown(cwd: string): ReturnType<typeof runLich> {
  return runLich(["down"], {
    cwd,
    env: { LICH_HOME: lichHome! },
    timeout: 60_000,
  });
}

function listStackEntries(): string[] {
  const stacksRoot = join(lichHome!, "stacks");
  if (!existsSync(stacksRoot)) return [];
  return readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Read each <LICH_HOME>/stacks/<id>/state.json and return its parsed shape. */
function readAllStates(): Array<{ stack_id: string; worktree_name: string; worktree_path: string; status: string }> {
  const out: Array<{ stack_id: string; worktree_name: string; worktree_path: string; status: string }> = [];
  for (const id of listStackEntries()) {
    const p = join(lichHome!, "stacks", id, "state.json");
    if (!existsSync(p)) continue;
    try {
      const snap = JSON.parse(readFileSync(p, "utf8"));
      out.push({
        stack_id: snap.stack_id,
        worktree_name: snap.worktree_name,
        worktree_path: snap.worktree_path,
        status: snap.status,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function matchesPath(snapPath: string, expected: string): boolean {
  return (
    snapPath === expected ||
    snapPath.endsWith(expected) ||
    expected.endsWith(snapPath)
  );
}

beforeAll(() => {
  if (!existsSync(lichBinary)) {
    execSync("bun run build", {
      cwd: resolve(repoRoot, "packages/lich"),
      stdio: "inherit",
    });
  }

  lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-worktree-flag-home-"));

  stackA = copyExampleToTmpdir("dogfood-stack", {
    prefix: "lich-e2e-wt-flag-a-",
    install: true,
  });
  stackB = copyExampleToTmpdir("dogfood-stack", {
    prefix: "lich-e2e-wt-flag-b-",
    install: true,
  });
});

afterAll(async () => {
  for (const sc of [stackA, stackB]) {
    if (!sc) continue;
    try {
      lichDown(sc.path);
    } catch {
      /* best-effort */
    }
  }
  await new Promise<void>((r) => setTimeout(r, 1_000));
  for (const sc of [stackA, stackB]) {
    if (!sc) continue;
    try {
      sc.cleanup();
    } catch {
      /* best-effort */
    }
  }
  stackA = null;
  stackB = null;

  if (lichHome) {
    try {
      rmSync(lichHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    lichHome = null;
  }
});

describe("--worktree flag (LEV-526)", () => {
  it(
    "(setup) brings up two parallel dev:fast stacks under one LICH_HOME",
    () => {
      const a = stackA!;
      const b = stackB!;

      const upA = lichUp(a.path);
      if (upA.exitCode !== 0) {
        throw new Error(
          `lich up A failed exit=${upA.exitCode}\nstdout:\n${upA.stdout}\nstderr:\n${upA.stderr}`,
        );
      }
      const upB = lichUp(b.path);
      if (upB.exitCode !== 0) {
        throw new Error(
          `lich up B failed exit=${upB.exitCode}\nstdout:\n${upB.stdout}\nstderr:\n${upB.stderr}`,
        );
      }

      const ids = listStackEntries();
      expect(ids.length).toBeGreaterThanOrEqual(2);

      const rows = readAllStates();
      const rowA = rows.find((r) => matchesPath(r.worktree_path, a.path));
      const rowB = rows.find((r) => matchesPath(r.worktree_path, b.path));
      expect(rowA, `no state.json row found for A path ${a.path}; rows=${JSON.stringify(rows)}`).toBeDefined();
      expect(rowB, `no state.json row found for B path ${b.path}; rows=${JSON.stringify(rows)}`).toBeDefined();

      stackIdA = rowA!.stack_id;
      stackIdB = rowB!.stack_id;
      worktreeNameA = rowA!.worktree_name;
      worktreeNameB = rowB!.worktree_name;
      expect(stackIdA).not.toBe(stackIdB);
    },
    300_000,
  );

  it("lich logs --worktree <id> targets the named stack from outside it", () => {
    expect(stackIdA, "(setup) must have run first").not.toBeNull();
    expect(stackIdB).not.toBeNull();

    // From inside A's worktree, target B with --worktree <id>.
    const logsB = runLich(
      ["logs", "--worktree", stackIdB!, "--count", "100", "--json"],
      {
        cwd: stackA!.path,
        env: { LICH_HOME: lichHome! },
        timeout: 15_000,
      },
    );
    expect(
      logsB.exitCode,
      `lich logs --worktree B failed:\nstdout:\n${logsB.stdout}\nstderr:\n${logsB.stderr}`,
    ).toBe(0);

    // Parse JSON payload — each line carries a `source` (service name); we
    // don't strongly assert content (logs may be empty on a fresh stack),
    // just that the command succeeded and produced a parseable JSON payload.
    const lines = logsB.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[lines.length - 1]!);
    expect(parsed).toHaveProperty("lines");
    expect(parsed).toHaveProperty("total_lines");
  });

  it("lich logs --worktree <name> resolves a friendly worktree name", () => {
    expect(worktreeNameB).not.toBeNull();
    const logs = runLich(
      ["logs", "--worktree", worktreeNameB!, "--count", "10", "--json"],
      {
        cwd: stackA!.path,
        env: { LICH_HOME: lichHome! },
        timeout: 15_000,
      },
    );
    expect(
      logs.exitCode,
      `lich logs --worktree by name failed:\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
    ).toBe(0);
  });

  it("lich urls --worktree <id> --raw lists the named stack's URLs", () => {
    const urlsB = runLich(["urls", "--worktree", stackIdB!, "--raw"], {
      cwd: stackA!.path,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(
      urlsB.exitCode,
      `lich urls --worktree failed:\nstdout:\n${urlsB.stdout}\nstderr:\n${urlsB.stderr}`,
    ).toBe(0);
    // dev:fast brings api + web up, both with allocated ports.
    expect(urlsB.stdout).toContain("api:");
    expect(urlsB.stdout).toContain("web:");
  });

  it("lich env --worktree <id> prints the stack's env_group", () => {
    const env = runLich(["env", "stack", "--worktree", stackIdB!], {
      cwd: stackA!.path,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(
      env.exitCode,
      `lich env --worktree failed:\nstdout:\n${env.stdout}\nstderr:\n${env.stderr}`,
    ).toBe(0);
    expect(env.stdout.length).toBeGreaterThan(0);
  });

  it("lich exec --worktree <id> runs in the named stack's worktree dir", () => {
    // pwd should be B's worktree path even though cwd is A.
    const exec = runLich(["exec", "--worktree", stackIdB!, "pwd"], {
      cwd: stackA!.path,
      env: { LICH_HOME: lichHome! },
      timeout: 10_000,
    });
    expect(
      exec.exitCode,
      `lich exec --worktree failed:\nstdout:\n${exec.stdout}\nstderr:\n${exec.stderr}`,
    ).toBe(0);
    // pwd output ends in B's path (realpath collapse may strip /private prefix on macOS).
    const out = exec.stdout.trim();
    expect(
      out === stackB!.path || stackB!.path.endsWith(out) || out.endsWith(stackB!.path),
      `pwd output ${out} should match B path ${stackB!.path}`,
    ).toBe(true);
  });

  it("lich logs --worktree <unknown> errors with a clear message", () => {
    const logs = runLich(
      ["logs", "--worktree", "no-such-stack-xxxxxxxx", "--count", "1"],
      {
        cwd: stackA!.path,
        env: { LICH_HOME: lichHome! },
        timeout: 5_000,
      },
    );
    expect(logs.exitCode).not.toBe(0);
    expect(logs.stdout + logs.stderr).toMatch(/no stack found with ID\/name/);
    expect(logs.stdout + logs.stderr).toMatch(/lich stacks/);
  });

  it("lich nuke --worktree errors and points at the safer alternatives", () => {
    const nuke = runLich(["nuke", "--worktree", "any"], {
      cwd: lichHome!,
      env: { LICH_HOME: lichHome! },
      timeout: 5_000,
    });
    expect(nuke.exitCode).toBe(2);
    expect(nuke.stderr).toMatch(/--worktree is not supported/);
    expect(nuke.stderr).toMatch(/--rescue/);
  });

  it("lich init --worktree is rejected", () => {
    const init = runLich(["init", "--worktree", "any"], {
      cwd: lichHome!,
      env: { LICH_HOME: lichHome! },
      timeout: 5_000,
    });
    expect(init.exitCode).toBe(2);
    expect(init.stderr).toMatch(/--worktree is not supported/);
  });

  it("lich validate --worktree is rejected", () => {
    const validate = runLich(["validate", "--worktree", "any"], {
      cwd: lichHome!,
      env: { LICH_HOME: lichHome! },
      timeout: 5_000,
    });
    expect(validate.exitCode).toBe(2);
    expect(validate.stderr).toMatch(/--worktree is not supported/);
  });

  it("lich logs --worktree works from a cwd that has no lich.yaml", () => {
    // cwd lichHome itself contains no lich.yaml. Without --worktree this
    // would fail to detect a worktree. With --worktree it resolves purely
    // against the catalog.
    const logs = runLich(
      ["logs", "--worktree", stackIdA!, "--count", "10", "--json"],
      {
        cwd: lichHome!,
        env: { LICH_HOME: lichHome! },
        timeout: 10_000,
      },
    );
    expect(
      logs.exitCode,
      `lich logs --worktree from cwd outside any worktree failed:\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
    ).toBe(0);
  });

  it(
    "lich down --worktree <id> tears down the named stack from outside it",
    () => {
      // Take B down via --worktree from inside A's worktree.
      const down = runLich(["down", "--worktree", stackIdB!], {
        cwd: stackA!.path,
        env: { LICH_HOME: lichHome! },
        timeout: 60_000,
      });
      expect(
        down.exitCode,
        `lich down --worktree failed:\nstdout:\n${down.stdout}\nstderr:\n${down.stderr}`,
      ).toBe(0);

      // Verify the snapshot was updated for B specifically; A should remain up.
      const stacks = runLich(["stacks", "--json"], {
        cwd: lichHome!,
        env: { LICH_HOME: lichHome! },
      });
      expect(stacks.exitCode).toBe(0);
      const rows = JSON.parse(stacks.stdout) as Array<{
        stack_id: string;
        status: string;
      }>;
      const rowB = rows.find((r) => r.stack_id === stackIdB);
      const rowA = rows.find((r) => r.stack_id === stackIdA);
      expect(rowB?.status, "B should be stopped after lich down --worktree B").toBe(
        "stopped",
      );
      expect(rowA?.status, "A should still be up after down --worktree B").toBe(
        "up",
      );
    },
    120_000,
  );
});
