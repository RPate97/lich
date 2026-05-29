import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root directory for per-stack state: `$LICH_HOME/stacks` or `~/.lich/stacks`. */
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

/** Per-hook log directory: `<stackDir>/hooks/<phase>-<idx>.log`. */
export function hooksDir(stackId: string): string {
  return join(stackDir(stackId), "hooks");
}

/** Path to a service log file: `<stackDir>/logs/<service>.log`. */
export function serviceLogPath(stackId: string, serviceName: string): string {
  return join(logsDir(stackId), `${serviceName}.log`);
}

/** Path to a service env file: `<stackDir>/env/<service>.env`. */
export function serviceEnvPath(stackId: string, serviceName: string): string {
  return join(envDir(stackId), `${serviceName}.env`);
}

/** Creates the stack directory and its `logs/`, `env/`, `hooks/` subdirs. Idempotent. */
export async function ensureStackDir(stackId: string): Promise<void> {
  await mkdir(stackDir(stackId), { recursive: true });
  await mkdir(logsDir(stackId), { recursive: true });
  await mkdir(envDir(stackId), { recursive: true });
  await mkdir(hooksDir(stackId), { recursive: true });
}

/** Removes the stack directory recursively. Idempotent. */
export async function removeStackDir(stackId: string): Promise<void> {
  await rm(stackDir(stackId), { recursive: true, force: true });
}

/** Returns stack ids (subdirectory names) under `stateRoot()`, or `[]` if it doesn't exist. */
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
      // skip entries we can't stat (race with concurrent removal)
    }
  }
  return ids.sort();
}
