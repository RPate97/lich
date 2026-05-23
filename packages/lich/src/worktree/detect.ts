import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Per-worktree identity used to scope all stack-related resources
 * (compose project name, allocated ports, state directory, friendly URLs).
 */
export interface Worktree {
  /**
   * Human-readable name, used in friendly URLs and stack ids.
   * Derived from the worktree dir basename, sanitized to [a-z0-9-]+.
   */
  name: string;
  /**
   * Stable deterministic id derived from the absolute worktree path.
   * Same path => same id across runs.
   */
  id: string;
  /**
   * Absolute path to the worktree root (where lich.yaml lives, or the
   * git worktree root when lich.yaml hasn't been written yet).
   */
  path: string;
  /**
   * The resolved stack id used everywhere: `${name}-${id.slice(0, 8)}`.
   * Readable and collision-resistant.
   */
  stack_id: string;
}

const CONFIG_FILENAME = "lich.yaml";

/**
 * Walk up from `cwd` looking for `lich.yaml`. If found, that directory
 * is the worktree root. If we hit the git repo root without finding one,
 * throw a useful error. If we are not inside a git repo at all, the walk
 * runs to the filesystem root and throws — callers outside a git repo
 * must point at a directory that contains `lich.yaml`.
 *
 * The error message names the cwd we started from and the git root (if
 * known) so the user can immediately see where to put the file.
 */
export function detectWorktree(cwd: string): Worktree {
  const startReal = realPathSafe(resolve(cwd));
  const gitRoot = findGitRoot(startReal);
  const stopAt = gitRoot ?? null;

  let current = startReal;
  // walk up looking for lich.yaml, bounded by the git root if we have one
  // (when there's no git root, we walk all the way to '/').
  while (true) {
    const candidate = resolve(current, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return buildWorktree(current);
    }
    if (stopAt && current === stopAt) {
      throw new Error(
        `No ${CONFIG_FILENAME} found from ${startReal} up to git root ${stopAt}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      // hit filesystem root without finding it (no git root either)
      throw new Error(
        `No ${CONFIG_FILENAME} found from ${startReal} up to filesystem root`,
      );
    }
    current = parent;
  }
}

function buildWorktree(rootPath: string): Worktree {
  const abs = realPathSafe(rootPath);
  const name = sanitizeName(basename(abs));
  const id = hashPath(abs);
  return {
    name,
    id,
    path: abs,
    stack_id: `${name}-${id.slice(0, 8)}`,
  };
}

/**
 * Sanitize an arbitrary string into a slug suitable for use in compose
 * project names, DNS subdomains, and shell-safe identifiers.
 *
 * Rules: lowercase, replace any char outside [a-z0-9-] with '-', collapse
 * runs of '-', trim leading/trailing '-'. Always returns a non-empty
 * string ('stack' as the final fallback).
 */
export function sanitizeName(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "stack";
}

/**
 * Stable deterministic id for a worktree, derived from its absolute path.
 * sha256(absPath), first 12 hex chars. Same path -> same id across runs.
 */
export function hashPath(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

function realPathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Find the enclosing git repo root by shelling out to `git rev-parse`.
 * Returns null if `dir` is not inside a git repo, or if git is not
 * available on PATH.
 */
function findGitRoot(dir: string): string | null {
  // Start from a directory that actually exists; git rev-parse needs that.
  let probe = dir;
  while (!safeIsDir(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: probe,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    return realPathSafe(out);
  } catch {
    return null;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
