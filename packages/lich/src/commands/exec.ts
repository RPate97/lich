/**
 * `lich exec [--env-group=<group>] <cmd> [args...]` — run a command with
 * the resolved env_group loaded. Default group is `"stack"`.
 *
 * Argv dispatch:
 *   - Single arg (`lich exec "echo $HOME"`) → `/bin/sh -c <arg>` so shell
 *     syntax (interpolation, pipes, redirections) works.
 *   - Multi arg (`lich exec ls -la apps/api`) → spawn `argv[0]` directly
 *     with `argv.slice(1)`; each token is literal, no shell interpretation.
 *
 * This sidesteps the shell-quoting bugs that come from naively joining
 * multi-arg input through `/bin/sh -c`.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import { detectWorktree, findMainWorktreePath, hashPath, sanitizeName, type Worktree } from "../worktree/detect.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  type AllocatedPorts,
  type StackSnapshot,
} from "../state/snapshot.js";
import { resolveStackId } from "../state/resolve-stack.js";
import { resolveEnvGroup } from "../groups/resolve.js";
import {
  resolveProfile,
  type ResolvedProfile,
} from "../profiles/resolve.js";

export interface ExecOptions {
  /**
   * Single entry → `/bin/sh -c <entry>` (shell mode). Multiple entries →
   * `spawn(argv[0], argv.slice(1))` (literal mode). Empty → usage + exit 2.
   */
  argv: string[];
  /** env_group name (`--env-group=<X>`). Defaults to `"stack"`. */
  envGroupName?: string;
  cwd?: string;
  /** Stack ID or worktree name (`--worktree`); defaults to cwd-derived. */
  worktreeArg?: string;
  /** SIGINT → kill child + exit 130. */
  signal?: AbortSignal;
  /** Defaults to `"inherit"`; tests pass `"pipe"`. */
  stdio?: StdioOptions;
  stderr?: (line: string) => void;
  /** Test hook: synchronously called with the spawned child handle. */
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
  /** When true, skip the stack-not-up warning (for scripts). */
  noPreflight?: boolean;
  /** Test hook: override "now" for deterministic relative-time strings. */
  now?: () => Date;
}

export interface ExecResult {
  /**
   * Exit code conventions:
   *   2   — usage error (empty argv, unknown env-group)
   *   1   — config parse / env-resolution failure
   *   127 — spawn failed (sh missing, no such binary)
   *   130 — SIGINT-aborted (128 + 2)
   *   else — child's own exit code
   */
  exitCode: number;
}

export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const cwd = opts.cwd ?? process.cwd();
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const stdio = opts.stdio ?? "inherit";
  const envGroupName = opts.envGroupName ?? "stack";

  if (!opts.argv || opts.argv.length === 0) {
    err("usage: lich exec [--env-group=<group>] <cmd> [args...]\n");
    return { exitCode: 2 };
  }

  let worktree: Worktree;
  let snap: StackSnapshot | null;
  if (opts.worktreeArg !== undefined && opts.worktreeArg.length > 0) {
    try {
      const resolved = await resolveStackId({ cwd, worktreeArg: opts.worktreeArg });
      snap = resolved.snapshot ?? (await readSnapshot(resolved.stackId).catch(() => null));
      if (!snap) {
        err(`lich exec: no snapshot for stack '${resolved.stackId}'\n`);
        return { exitCode: 1 };
      }
      worktree = worktreeFromSnapshot(snap);
    } catch (e) {
      err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
      return { exitCode: 1 };
    }
  } else {
    // Legacy order: yaml-missing diagnostic before detectWorktree's walk-up.
    const yamlPathCwd = join(cwd, "lich.yaml");
    if (!existsSync(yamlPathCwd)) {
      err(`lich exec: lich.yaml not found at ${yamlPathCwd}\n`);
      return { exitCode: 1 };
    }
    try {
      worktree = detectWorktree(cwd);
    } catch (e) {
      err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
      return { exitCode: 1 };
    }
    snap = await readSnapshot(worktree.stack_id).catch(() => null);
  }

  const yamlPath = join(worktree.path, "lich.yaml");
  if (!existsSync(yamlPath)) {
    err(`lich exec: lich.yaml not found at ${yamlPath}\n`);
    return { exitCode: 1 };
  }
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      err(`${e.location}: ${e.message}\n`);
    }
    return { exitCode: 1 };
  }
  const config = parsed.config;

  // No snapshot (stack down) → empty allocated ports; resolver only fails
  // if a value actually references a missing port.
  const allocatedPorts: AllocatedPorts = snap
    ? rebuildAllocatedPorts(snap)
    : { compose: {}, owned: {} };

  if (!opts.noPreflight) {
    const warning = preflightWarning(snap, worktree.name, opts.now?.() ?? new Date());
    if (warning) err(`[lich] ${warning}\n`);
  }

  // Re-resolve the active profile from the on-disk yaml so the env group
  // sees profile-scoped env overrides. Drift-tolerant: if the yaml has
  // changed and the recorded profile no longer resolves, fall back to
  // top-level-only env. Broken-yaml diagnosis flows through `lich validate`.
  let resolvedProfile: ResolvedProfile | undefined;
  if (snap?.active_profile && config.profiles?.[snap.active_profile]) {
    try {
      resolvedProfile = resolveProfile(snap.active_profile, config);
    } catch {
      resolvedProfile = undefined;
    }
  }

  let env: Record<string, string>;
  try {
    env = await resolveEnvGroup({
      name: envGroupName,
      config,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
      profile: resolvedProfile,
    });
  } catch (e) {
    err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  const isShellForm = opts.argv.length === 1;
  const command = isShellForm ? "/bin/sh" : opts.argv[0];
  const args = isShellForm ? ["-c", opts.argv[0]] : opts.argv.slice(1);

  return new Promise<ExecResult>((resolve) => {
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: worktree.path,
      env,
      stdio,
    });

    if (opts.onSpawn) {
      opts.onSpawn(child);
    }

    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
      resolve({ exitCode: 127 });
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      // Prefer 130 over child's own code when we initiated the abort,
      // so a fast-exiting aborted child doesn't surface as 0.
      if (aborted) {
        resolve({ exitCode: 130 });
        return;
      }
      if (code === null) {
        // Killed by a signal we didn't send; use 128+N convention.
        const sigNum = signal ? signalToNumber(signal) : null;
        resolve({ exitCode: sigNum !== null ? 128 + sigNum : 1 });
        return;
      }
      resolve({ exitCode: code });
    });

    const handleAbort = (): void => {
      aborted = true;
      if (!settled && child.pid !== undefined) {
        try {
          child.kill("SIGINT");
        } catch {
          /* child already exited */
        }
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        handleAbort();
      } else {
        opts.signal.addEventListener("abort", handleAbort, { once: true });
      }
    }
  });
}

/** Returns the stderr warning when the stack isn't up, or null when it is. */
export function preflightWarning(
  snap: StackSnapshot | null,
  worktreeName: string,
  now: Date,
): string | null {
  if (!snap) {
    return `warning: no lich stack in this worktree (run 'lich up' first). Command will run but services may be unreachable.`;
  }
  if (snap.status === "up") return null;
  const lastSeen = formatRelativeAge(snap.started_at, now);
  const suffix = lastSeen ? ` (last seen: ${lastSeen})` : "";
  return `warning: stack '${worktreeName}' is not up${suffix}. Command will run but services may be unreachable.`;
}

function formatRelativeAge(iso: string | undefined, now: Date): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Rebuild a `Worktree` from a snapshot for cross-worktree command targeting. */
function worktreeFromSnapshot(snap: StackSnapshot): Worktree {
  const path = snap.worktree_path;
  const name = sanitizeName(snap.worktree_name);
  const id = hashPath(path);
  return { name, id, path, stack_id: snap.stack_id, main_path: findMainWorktreePath(path) ?? path };
}

/** Map a POSIX signal name to its number for `128 + N` exit-code derivation. */
function signalToNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGQUIT":
      return 3;
    case "SIGKILL":
      return 9;
    case "SIGTERM":
      return 15;
    default:
      return null;
  }
}
