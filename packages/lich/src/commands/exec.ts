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
import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  type AllocatedPorts,
} from "../state/snapshot.js";
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
  /** SIGINT → kill child + exit 130. */
  signal?: AbortSignal;
  /** Defaults to `"inherit"`; tests pass `"pipe"`. */
  stdio?: StdioOptions;
  stderr?: (line: string) => void;
  /** Test hook: synchronously called with the spawned child handle. */
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
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

  const yamlPath = join(cwd, "lich.yaml");
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

  let worktree: ReturnType<typeof detectWorktree>;
  try {
    worktree = detectWorktree(cwd);
  } catch (e) {
    err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  // No snapshot (stack down) → empty allocated ports; resolver only fails
  // if a value actually references a missing port.
  let allocatedPorts: AllocatedPorts = { compose: {}, owned: {} };
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap) {
    allocatedPorts = rebuildAllocatedPorts(snap);
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
