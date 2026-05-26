import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServiceSnapshot {
  name: string;
  kind: "compose" | "owned";
  state: string;
  allocated_ports?: Record<string, number>;
  started_at?: string;
  pid?: number;
}

export interface StackSnapshot {
  stack_id: string;
  worktree_name: string;
  worktree_path: string;
  status: string;
  started_at: string;
  services: ServiceSnapshot[];
  /** Plan 3: profile this stack was started under, when one was active. */
  active_profile?: string;
}

/**
 * Resolve the state.json path for a stack given LICH_HOME.
 *
 * Layout (mirrors packages/lich/src/state/directory.ts):
 *   <LICH_HOME>/stacks/<stack-id>/state.json
 */
export function stateJsonPath(lichHome: string, stackId: string): string {
  return join(lichHome, "stacks", stackId, "state.json");
}

/** Read the snapshot for a stack id, or null if state.json does not exist. */
export function readStateJson(
  lichHome: string,
  stackId: string,
): StackSnapshot | null {
  const p = stateJsonPath(lichHome, stackId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StackSnapshot;
  } catch {
    return null;
  }
}

export interface WaitForStateOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll state.json until `status` equals one of the expected values, or until
 * the timeout fires. Returns the snapshot when matched; throws on timeout.
 */
export async function waitForStackStatus(
  lichHome: string,
  stackId: string,
  expected: string | string[],
  opts: WaitForStateOptions = {},
): Promise<StackSnapshot> {
  const want = Array.isArray(expected) ? expected : [expected];
  const timeout = opts.timeoutMs ?? 60_000;
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeout;

  let last: StackSnapshot | null = null;
  while (Date.now() < deadline) {
    last = readStateJson(lichHome, stackId);
    if (last && want.includes(last.status)) {
      return last;
    }
    await sleep(interval);
  }

  throw new Error(
    `timeout waiting for stack ${stackId} status in [${want.join(", ")}] after ${timeout}ms — last status: ${last?.status ?? "(no state.json)"}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
