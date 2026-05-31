import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStackId } from "../../../src/state/resolve-stack.js";
import { writeSnapshot, type StackSnapshot } from "../../../src/state/snapshot.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-resolve-stack-home-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevLichHome;
  rmSync(home, { recursive: true, force: true });
});

function makeSnapshot(stackId: string, worktreeName: string): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: worktreeName,
    worktree_path: `/tmp/${worktreeName}`,
    status: "up",
    started_at: new Date().toISOString(),
    services: [],
  };
}

describe("resolveStackId", () => {
  it("falls back to cwd-derived worktree when --worktree is absent", async () => {
    const wtRoot = mkdtempSync(join(tmpdir(), "lich-resolve-cwd-"));
    try {
      writeFileSync(join(wtRoot, "lich.yaml"), 'version: "1"\n', "utf8");
      const expected = detectWorktree(wtRoot);

      const got = await resolveStackId({ cwd: wtRoot });
      expect(got.stackId).toBe(expected.stack_id);
      expect(got.worktree?.path).toBe(expected.path);
    } finally {
      rmSync(wtRoot, { recursive: true, force: true });
    }
  });

  it("resolves an exact stack ID match regardless of cwd", async () => {
    await writeSnapshot(makeSnapshot("alpha-12345678", "alpha"));
    await writeSnapshot(makeSnapshot("beta-87654321", "beta"));

    const got = await resolveStackId({
      cwd: "/tmp/anywhere",
      worktreeArg: "beta-87654321",
    });
    expect(got.stackId).toBe("beta-87654321");
    expect(got.snapshot?.worktree_name).toBe("beta");
  });

  it("resolves a friendly worktree name match", async () => {
    await writeSnapshot(makeSnapshot("only-name-12345678", "feature-x"));

    const got = await resolveStackId({
      cwd: "/tmp/anywhere",
      worktreeArg: "feature-x",
    });
    expect(got.stackId).toBe("only-name-12345678");
  });

  it("prefers exact stack ID over a friendly-name collision", async () => {
    await writeSnapshot(makeSnapshot("featurex", "shared"));
    await writeSnapshot(makeSnapshot("other-id", "featurex"));

    const got = await resolveStackId({
      cwd: "/tmp/anywhere",
      worktreeArg: "featurex",
    });
    expect(got.stackId).toBe("featurex");
  });

  it("throws on ambiguous friendly-name matches with all candidates listed", async () => {
    await writeSnapshot(makeSnapshot("twin-aaaaaaaa", "twin"));
    await writeSnapshot(makeSnapshot("twin-bbbbbbbb", "twin"));

    await expect(
      resolveStackId({ cwd: "/tmp/anywhere", worktreeArg: "twin" }),
    ).rejects.toThrow(/twin-aaaaaaaa/);
    await expect(
      resolveStackId({ cwd: "/tmp/anywhere", worktreeArg: "twin" }),
    ).rejects.toThrow(/twin-bbbbbbbb/);
  });

  it("throws on unknown ID/name with a stacks hint", async () => {
    await writeSnapshot(makeSnapshot("alpha-12345678", "alpha"));

    await expect(
      resolveStackId({ cwd: "/tmp/anywhere", worktreeArg: "missing" }),
    ).rejects.toThrow(/no stack found with ID\/name 'missing'/);
    await expect(
      resolveStackId({ cwd: "/tmp/anywhere", worktreeArg: "missing" }),
    ).rejects.toThrow(/lich stacks/);
  });

  it("throws on empty stacks directory when --worktree is given", async () => {
    await expect(
      resolveStackId({ cwd: "/tmp/anywhere", worktreeArg: "anything" }),
    ).rejects.toThrow(/no stack found with ID\/name 'anything'/);
  });
});
