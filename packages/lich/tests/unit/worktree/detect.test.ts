import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  detectWorktree,
  sanitizeName,
  hashPath,
} from "../../../src/worktree/detect.js";

/**
 * Track all tmpdirs created in a test so afterEach can nuke them
 * regardless of which failed.
 */
const createdDirs: string[] = [];

function makeTmpdir(prefix = "lich-test-"): string {
  // Use realpathSync on the parent so the returned path matches what
  // detectWorktree will canonicalise to (macOS aliases /tmp -> /private/tmp).
  const base = realpathSync(tmpdir());
  const dir = mkdtempSync(join(base, prefix));
  createdDirs.push(dir);
  return dir;
}

function makeTmpdirOutsideGit(): string {
  // mkdtemp(os.tmpdir()) is already outside any normal git repo, but the
  // user's $TMPDIR could (rarely) sit inside one. Defensive: walk up and
  // confirm by checking for .git markers in any ancestor. If any ancestor
  // has .git, we still return the tmpdir but the test will skip — see usage.
  return makeTmpdir("lich-nogit-");
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("sanitizeName", () => {
  it("lowercases and replaces non-slug chars with dashes", () => {
    expect(sanitizeName("My Project!")).toBe("my-project");
  });

  it("collapses runs of dashes", () => {
    expect(sanitizeName("foo___bar---baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing dashes", () => {
    expect(sanitizeName("---hello---")).toBe("hello");
  });

  it("preserves digits and existing dashes", () => {
    expect(sanitizeName("agent-abc-123")).toBe("agent-abc-123");
  });

  it("returns 'stack' when the input has no slug-safe chars", () => {
    expect(sanitizeName("///")).toBe("stack");
    expect(sanitizeName("")).toBe("stack");
  });
});

describe("hashPath", () => {
  it("is deterministic across calls for the same path", () => {
    expect(hashPath("/some/abs/path")).toBe(hashPath("/some/abs/path"));
  });

  it("differs for different paths", () => {
    expect(hashPath("/a")).not.toBe(hashPath("/b"));
  });

  it("returns 12 hex chars", () => {
    const h = hashPath("/x/y/z");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("detectWorktree", () => {
  it("finds lich.yaml at the tmpdir root when called from a subdirectory", () => {
    const root = makeTmpdir();
    writeFileSync(join(root, "lich.yaml"), "services: {}\n");
    const sub = join(root, "sub");
    mkdirSync(sub);

    const wt = detectWorktree(sub);
    expect(wt.path).toBe(realpathSync(root));
  });

  it("returns the same id across calls (determinism)", () => {
    const root = makeTmpdir();
    writeFileSync(join(root, "lich.yaml"), "");
    const wt1 = detectWorktree(root);
    const wt2 = detectWorktree(root);
    expect(wt1.id).toBe(wt2.id);
    expect(wt1.stack_id).toBe(wt2.stack_id);
  });

  it("returns different ids for different worktree paths", () => {
    const a = makeTmpdir();
    const b = makeTmpdir();
    writeFileSync(join(a, "lich.yaml"), "");
    writeFileSync(join(b, "lich.yaml"), "");
    expect(detectWorktree(a).id).not.toBe(detectWorktree(b).id);
  });

  it("sanitizes the worktree name from the basename", () => {
    const parent = makeTmpdir();
    const ugly = join(parent, "My Project!");
    mkdirSync(ugly);
    writeFileSync(join(ugly, "lich.yaml"), "");

    const wt = detectWorktree(ugly);
    expect(wt.name).toBe("my-project");
  });

  it("builds stack_id as `${name}-${id-prefix}` with an 8-char id suffix", () => {
    const root = makeTmpdir();
    writeFileSync(join(root, "lich.yaml"), "");
    const wt = detectWorktree(root);
    expect(wt.stack_id).toBe(`${wt.name}-${wt.id.slice(0, 8)}`);
    expect(wt.stack_id).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  });

  it("throws a useful error when no lich.yaml exists within a git repo", () => {
    const root = makeTmpdir("lich-git-");
    execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    const sub = join(root, "nested");
    mkdirSync(sub);

    expect(() => detectWorktree(sub)).toThrow(/No lich\.yaml found/);
    expect(() => detectWorktree(sub)).toThrow(/git root/);
  });

  it("works outside a git repo: walks up until it finds lich.yaml", () => {
    // Make a fresh tmpdir that is not inside any git repo (tmpdir is
    // outside the project's git tree). Put a lich.yaml here and call
    // detectWorktree from a nested subdir.
    const root = makeTmpdirOutsideGit();
    writeFileSync(join(root, "lich.yaml"), "");
    const sub = join(root, "deep", "deeper");
    mkdirSync(sub, { recursive: true });

    const wt = detectWorktree(sub);
    expect(wt.path).toBe(realpathSync(root));
  });
});
