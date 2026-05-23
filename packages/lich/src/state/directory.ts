/**
 * Per-worktree state directory management.
 *
 * Layout (per spec section 3 / 9):
 *
 *   ~/.lich/stacks/<stack-id>/
 *     state.json            # the StackSnapshot
 *     logs/<service>.log    # per-service log files
 *     env/<service>.env     # per-service generated env files
 *
 * The root directory can be overridden via the `LICH_HOME` environment
 * variable so tests can point at a tmpdir without touching the real
 * `~/.lich`. When `LICH_HOME` is set, the layout is `<LICH_HOME>/stacks/...`.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the root directory where lich stores per-stack state.
 *
 * Resolution order:
 *   1. `$LICH_HOME/stacks` if `LICH_HOME` is set (used by tests)
 *   2. `~/.lich/stacks` otherwise
 */
export function stateRoot(): string {
  const override = process.env.LICH_HOME;
  if (override && override.length > 0) {
    return join(override, "stacks");
  }
  return join(homedir(), ".lich", "stacks");
}

/** Directory for a single stack: `<stateRoot>/<stack-id>/`. */
export function stackDir(stackId: string): string {
  return join(stateRoot(), stackId);
}

/** Per-service log directory: `<stackDir>/logs/`. */
export function logsDir(stackId: string): string {
  return join(stackDir(stackId), "logs");
}

/** Per-service env directory: `<stackDir>/env/`. */
export function envDir(stackId: string): string {
  return join(stackDir(stackId), "env");
}

/** Path to a service log file: `<stackDir>/logs/<service>.log`. */
export function serviceLogPath(stackId: string, serviceName: string): string {
  return join(logsDir(stackId), `${serviceName}.log`);
}

/** Path to a service env file: `<stackDir>/env/<service>.env`. */
export function serviceEnvPath(stackId: string, serviceName: string): string {
  return join(envDir(stackId), `${serviceName}.env`);
}

/**
 * Creates the stack directory and its `logs/` and `env/` subdirectories.
 * Idempotent: calling it on an already-existing layout is a no-op.
 */
export async function ensureStackDir(stackId: string): Promise<void> {
  await mkdir(stackDir(stackId), { recursive: true });
  await mkdir(logsDir(stackId), { recursive: true });
  await mkdir(envDir(stackId), { recursive: true });
}

/**
 * Removes the stack directory (recursive). Idempotent — succeeds silently
 * if the directory does not exist.
 */
export async function removeStackDir(stackId: string): Promise<void> {
  await rm(stackDir(stackId), { recursive: true, force: true });
}

/**
 * Returns the stack ids found under `stateRoot()`. Each entry is a
 * subdirectory name (the stack id); non-directory entries are skipped.
 * Returns `[]` if `stateRoot()` does not exist yet.
 */
export async function listStacks(): Promise<string[]> {
  const root = stateRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const ids: string[] = [];
  for (const name of entries) {
    try {
      const s = await stat(join(root, name));
      if (s.isDirectory()) {
        ids.push(name);
      }
    } catch {
      // Skip entries we can't stat (race with concurrent removal, etc.).
    }
  }
  return ids.sort();
}
