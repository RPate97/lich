import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Per-worktree identity used to scope all stack-related resources. */
export interface Worktree {
  /** Human-readable name from the dir basename, sanitized to [a-z0-9-]+. */
  name: string;
  /** Deterministic id derived from the absolute worktree path. */
  id: string;
  /** Absolute path to the worktree root. */
  path: string;
  /** Resolved stack id: `${name}-${id.slice(0, 8)}`. */
  stack_id: string;
  /**
   * Absolute path to the *main* worktree (the directory containing the shared
   * `.git` dir). Equals `path` when this IS the main worktree, or when not in
   * a git repo at all. Used as a fallback root for relative `env_files` so
   * secondary worktrees can transparently share a `.env` kept in the main
   * checkout without symlinks.
   */
  main_path: string;
}

const CONFIG_FILENAME = "lich.yaml";

/**
 * Walk up from `cwd` looking for `lich.yaml`, bounded by the enclosing
 * git root (or the filesystem root if not in a git repo). Throws when
 * the file isn't found.
 */
export function detectWorktree(cwd: string): Worktree {
  const startReal = realPathSafe(resolve(cwd));
  const gitRoot = findGitRoot(startReal);
  const stopAt = gitRoot ?? null;

  let current = startReal;
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
    main_path: findMainWorktreePath(abs) ?? abs,
  };
}

/**
 * Build a `Worktree` for cross-worktree commands that operate on a saved
 * snapshot (e.g. `lich down --all`, `lich logs <stack>`). The snapshot has the
 * worktree's path and name but not its `main_path`, so we recompute it via
 * git from the saved path.
 */
export function worktreeFromSnapshot(snap: {
  worktree_path: string;
  worktree_name: string;
  stack_id: string;
}): Worktree {
  const path = snap.worktree_path;
  return {
    name: sanitizeName(snap.worktree_name),
    id: hashPath(path),
    path,
    stack_id: snap.stack_id,
    main_path: findMainWorktreePath(path) ?? path,
  };
}

/**
 * Main worktree path = parent of the shared `.git` directory.
 * `git rev-parse --git-common-dir` returns the shared dir (absolute in
 * secondary worktrees, relative `.git` in the main); we resolve it
 * against the worktree root and take the parent.
 *
 * Returns null when not in a git repo (lich works without git too).
 */
export function findMainWorktreePath(worktreeRoot: string): string | null {
  if (!safeIsDir(worktreeRoot)) return null;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreeRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    const absoluteCommonDir = resolve(worktreeRoot, out);
    return realPathSafe(dirname(absoluteCommonDir));
  } catch {
    return null;
  }
}

/**
 * Sanitize a string into a slug for compose project names, DNS
 * subdomains, and shell-safe identifiers. Always returns a non-empty
 * string (`stack` as the fallback).
 */
export function sanitizeName(raw: string): string {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.length > 0 ? trimmed : "stack";
}

/** sha256(absPath), first 12 hex chars. Same path -> same id across runs. */
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

function findGitRoot(dir: string): string | null {
  // Start from an existing directory; git rev-parse requires that.
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
