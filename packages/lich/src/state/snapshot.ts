/**
 * Read/write the per-stack `state.json` snapshot.
 *
 * The snapshot captures everything a fresh `lich` process (or the daemon's
 * state watcher) needs to discover what's running for this stack without
 * IPC: which services exist, which ports they got, when they started, etc.
 *
 * Writes are atomic: we write to a sibling tmp file under the same
 * directory and `rename()` into place. Rename is atomic on the same
 * filesystem, so concurrent readers either see the previous snapshot or
 * the new one — never a partial JSON document.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { ensureStackDir, stackDir } from "./directory.js";
import { join } from "node:path";

export type ServiceState =
  | "starting"
  | "healthy"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface ServiceSnapshot {
  name: string;
  kind: "compose" | "owned";
  state: ServiceState;
  /** Logical port name -> allocated host port. */
  allocated_ports?: Record<string, number>;
  /** ISO 8601 timestamp. */
  started_at?: string;
  /** Process id; only meaningful for owned services. */
  pid?: number;
}

export type StackStatus =
  | "starting"
  | "up"
  | "partial"
  | "stopping"
  | "stopped"
  | "failed";

export interface StackSnapshot {
  stack_id: string;
  worktree_name: string;
  worktree_path: string;
  status: StackStatus;
  /** ISO 8601 timestamp. */
  started_at: string;
  services: ServiceSnapshot[];
}

function snapshotPath(stackId: string): string {
  return join(stackDir(stackId), "state.json");
}

/**
 * Reads the snapshot for a stack.
 * Returns `null` if `state.json` does not exist.
 */
export async function readSnapshot(
  stackId: string,
): Promise<StackSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(snapshotPath(stackId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return JSON.parse(raw) as StackSnapshot;
}

/**
 * Writes a snapshot atomically.
 *
 * Strategy: serialize, write to `<stackDir>/state.json.<random>.tmp`,
 * then `rename()` into `state.json`. If serialization throws, we never
 * create the tmp file. If the write throws, we attempt to clean the tmp
 * file but the destination `state.json` is untouched. The rename itself
 * is atomic on any sane filesystem, so a concurrent reader either sees
 * the old contents or the new contents — never half a document.
 */
export async function writeSnapshot(snapshot: StackSnapshot): Promise<void> {
  // Throw eagerly on bad input — keeps the tmp-file path off-disk.
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";

  await ensureStackDir(snapshot.stack_id);

  const dest = snapshotPath(snapshot.stack_id);
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup; ignore failures (tmp may not exist).
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Restore helpers
// ---------------------------------------------------------------------------

/**
 * Shape that {@link resolveEnvForService} expects for `allocatedPorts`. Kept
 * structurally compatible with the type defined in `env/resolve.ts` — both
 * are inlined rather than imported because `state/` shouldn't depend on
 * `env/` (state is foundational; env layers on top).
 */
export interface AllocatedPorts {
  /** Compose service name -> logical port name -> host port. */
  compose: Record<string, Record<string, number>>;
  /** Owned service name -> either { port } or { ports: { key: port } }. */
  owned: Record<string, { port?: number; ports?: Record<string, number> }>;
}

/**
 * Rebuild the {@link AllocatedPorts} shape from a {@link StackSnapshot}.
 *
 * `up.ts` flattens allocator output into per-service `allocated_ports` maps
 * on disk (a single `Record<string, number>` per service, regardless of
 * kind). Down/nuke need the original two-shape structure to feed
 * `resolveEnvForService` so stop_cmd sees the same env the service was
 * started with. This is the inverse of the per-service flattening that
 * happens in `up.ts` lines 290-302.
 *
 * Conventions baked in:
 *   - Compose service `allocated_ports` is the inner per-port map directly
 *     (key = logical port name, value = host port).
 *   - Owned service `allocated_ports` carries `default` as the single
 *     primary port (matching how `up.ts` writes `entry.port` under
 *     `m.default`). Any other keys came from the multi-port `entry.ports`
 *     and are routed back into `owned[name].ports`.
 *
 * Services with no `allocated_ports` are omitted from the result — they
 * had nothing to allocate at up time, so there's nothing for the
 * interpolation context to expose. Services in the snapshot that aren't
 * owned/compose (shouldn't exist by current types, but defensive) are
 * silently skipped.
 */
export function rebuildAllocatedPorts(
  snapshot: StackSnapshot,
): AllocatedPorts {
  const compose: AllocatedPorts["compose"] = {};
  const owned: AllocatedPorts["owned"] = {};

  for (const svc of snapshot.services) {
    const ports = svc.allocated_ports;
    if (!ports || Object.keys(ports).length === 0) continue;

    if (svc.kind === "compose") {
      // Compose: the snapshot already stores the inner per-port map.
      compose[svc.name] = { ...ports };
    } else if (svc.kind === "owned") {
      // Owned: `up.ts` writes the single-port value under the `default`
      // key and folds multi-port entries in alongside. Reverse it: pull
      // `default` out as `port`, everything else into `ports`.
      const entry: { port?: number; ports?: Record<string, number> } = {};
      const extras: Record<string, number> = {};
      let hasExtras = false;
      for (const [key, value] of Object.entries(ports)) {
        if (key === "default") {
          entry.port = value;
        } else {
          extras[key] = value;
          hasExtras = true;
        }
      }
      if (hasExtras) entry.ports = extras;
      if (entry.port !== undefined || entry.ports !== undefined) {
        owned[svc.name] = entry;
      }
    }
  }

  return { compose, owned };
}
