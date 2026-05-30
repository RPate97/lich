/**
 * Force-clean stray containers an oneshot owned service couldn't reap via `stop_cmd`.
 *
 * Drives the `owned_containers:` yaml key (LEV-534). After `stop_cmd` runs we sweep
 * for any container whose label/name matches the declared filter and `docker rm -f`
 * survivors. Catches the case where a wrapped CLI's stop subcommand misses a
 * container stuck in restart-backoff with Docker's `restart: always` policy.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface OwnedContainersSpec {
  label?: string;
  name_pattern?: string;
}

export interface SweepResult {
  /** Container IDs that matched the filter and were force-removed. */
  removed: string[];
  /** Container IDs that matched but couldn't be removed (still present after rm -f). */
  stragglers: string[];
}

/**
 * Indirection seam — tests stub the docker CLI calls without touching child_process.
 * Mirrors the `_probe` / `_exec` pattern used elsewhere in the codebase.
 */
export const _docker: {
  ps: (cli: string, filter: { kind: "label" | "name"; value: string }) => Promise<string[]>;
  rm: (cli: string, id: string) => Promise<{ ok: boolean }>;
} = {
  ps: defaultPs,
  rm: defaultRm,
};

async function defaultPs(
  cli: string,
  filter: { kind: "label" | "name"; value: string },
): Promise<string[]> {
  const filterArg = `${filter.kind}=${filter.value}`;
  try {
    const { stdout } = await execFile(cli, ["ps", "-aq", "--filter", filterArg], {
      timeout: 10_000,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

async function defaultRm(cli: string, id: string): Promise<{ ok: boolean }> {
  try {
    await execFile(cli, ["rm", "-f", id], { timeout: 15_000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Run the sweep for one owned service. No-op when no filter is declared.
 * Errors from the docker CLI are swallowed — best-effort cleanup, mirrors stop_cmd handling.
 */
export async function sweepOwnedContainers(
  cli: string,
  spec: OwnedContainersSpec | undefined,
): Promise<SweepResult> {
  if (!spec) return { removed: [], stragglers: [] };
  const filter = filterFromSpec(spec);
  if (filter === null) return { removed: [], stragglers: [] };

  const ids = await _docker.ps(cli, filter);
  if (ids.length === 0) return { removed: [], stragglers: [] };

  const removed: string[] = [];
  for (const id of ids) {
    const result = await _docker.rm(cli, id);
    if (result.ok) removed.push(id);
  }

  const stillThere = await _docker.ps(cli, filter);
  return { removed, stragglers: stillThere };
}

function filterFromSpec(
  spec: OwnedContainersSpec,
): { kind: "label" | "name"; value: string } | null {
  if (spec.label !== undefined && spec.label.length > 0) {
    return { kind: "label", value: spec.label };
  }
  if (spec.name_pattern !== undefined && spec.name_pattern.length > 0) {
    return { kind: "name", value: spec.name_pattern };
  }
  return null;
}
