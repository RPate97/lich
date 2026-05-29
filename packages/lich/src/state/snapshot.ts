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

/** Lifecycle hook entry with pre-resolved env — snapshotted at up time so down never re-parses yaml. */
export interface SnapshotLifecycleEntry {
  cmd: string;
  env: Record<string, string>;
}

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
  /** Human-readable failure explanation. Only persisted when state is "failed". */
  failure_reason?: string;
  /** Last ~20 log lines at failure time, oldest-first. Only persisted when state is "failed". */
  failure_log_tail?: string[];
  /** Resolved stop_cmd (post-interpolation). Snapshotted at up time. */
  stop_cmd?: string;
  /** Resolved cmd (post-interpolation). Snapshotted at up time. */
  cmd?: string;
  /** Fully resolved env the service ran with — used by down to run stop_cmd with the correct env. */
  resolved_env?: Record<string, string>;
  /** depends_on edges from the yaml at up time — used by down for reverse-topo teardown ordering. */
  depends_on?: string[];
  /** Per-service before_down hooks with pre-resolved env. */
  before_down?: SnapshotLifecycleEntry[];
  /** Resolved service cwd (absolute path). Used by per-service restart. */
  service_cwd?: string;
  /** Serialized ready_when config. Used by per-service restart (avoids yaml re-parse). */
  ready_when?: Record<string, unknown>;
}

export type StackStatus =
  | "starting"
  | "up"
  | "partial"
  | "stopping"
  | "stopped"
  | "failed";

/** Routing table entry mapping friendly hostname → upstream URL for the daemon's reverse proxy. */
export interface RoutingEntry {
  /** e.g. `"api.feature-x"` */
  hostname: string;
  /** e.g. `"http://127.0.0.1:9014"` */
  upstream_url: string;
  /** Owning service name — informational; the proxy routes by hostname. */
  service: string;
}

export interface StackSnapshot {
  stack_id: string;
  worktree_name: string;
  worktree_path: string;
  status: StackStatus;
  /** ISO 8601 timestamp. */
  started_at: string;
  services: ServiceSnapshot[];
  /** Name of the active profile, or omitted if none was active. */
  active_profile?: string;
  /**
   * Friendly-URL routing entries for the daemon's reverse proxy.
   * `undefined` = predates routing; `[]` = actively empty (e.g. just torn down).
   * Readers and the proxy must preserve that distinction.
   */
  routing?: RoutingEntry[];
  /** Top-level + profile before_down hooks with pre-resolved env, snapshotted at up time. */
  before_down?: SnapshotLifecycleEntry[];
  /** Top-level + profile after_down hooks with pre-resolved env, snapshotted at up time. */
  after_down?: SnapshotLifecycleEntry[];
}

function snapshotPath(stackId: string): string {
  return join(stackDir(stackId), "state.json");
}

/** Reads the snapshot for a stack. Returns `null` if `state.json` does not exist. */
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

/** Strips failure fields from non-failed services so stale metadata doesn't leak into state.json. */
function sanitizeForWrite(snapshot: StackSnapshot): StackSnapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((svc) => {
      if (svc.state === "failed") return svc;
      if (svc.failure_reason === undefined && svc.failure_log_tail === undefined)
        return svc;
      const { failure_reason: _r, failure_log_tail: _t, ...rest } = svc;
      return rest;
    }),
  };
}

/** Writes a snapshot atomically via write-to-tmp + rename. */
export async function writeSnapshot(snapshot: StackSnapshot): Promise<void> {
  // serialize before mkdir so bad input never creates the tmp file
  const serialized =
    JSON.stringify(sanitizeForWrite(snapshot), null, 2) + "\n";

  await ensureStackDir(snapshot.stack_id);

  const dest = snapshotPath(snapshot.stack_id);
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;

  try {
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Shape `resolveEnvForService` expects for `allocatedPorts`. Inlined rather
 * than imported from `env/` so this layer stays foundational (state → env, never the reverse).
 */
export interface AllocatedPorts {
  /** Compose service name → logical port name → host port. */
  compose: Record<string, Record<string, number>>;
  /** Owned service name → `{ port }` (single) or `{ ports }` (multi). */
  owned: Record<string, { port?: number; ports?: Record<string, number> }>;
}

/**
 * Inverse of the per-service flattening in `up.ts`: rebuild the two-shape
 * `AllocatedPorts` structure from the flat snapshot so down/nuke can feed
 * `resolveEnvForService` the same env the service was started with.
 *
 * For owned services, the snapshot stores the single-port value under
 * `default`; here we route `default` → `port` and other keys → `ports`.
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
      compose[svc.name] = { ...ports };
    } else if (svc.kind === "owned") {
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

/**
 * Inject the per-port env vars an owned service was started with (e.g.
 * `SUPABASE_API_PORT=9000`), so down/nuke can hand `stop_cmd` the same env
 * the service started with. Without this, env-substituted configs (e.g.
 * supabase's config.toml) see un-substituted `env(...)` literals at teardown.
 *
 * Returns a new object — does not mutate the input env.
 */
export function injectOwnedPortEnv(
  env: NodeJS.ProcessEnv,
  ownedDef:
    | {
        port?: number | { env?: string };
        ports?: Record<string, number | { env?: string }>;
      }
    | undefined,
  allocatedPorts: Record<string, number> | undefined,
): NodeJS.ProcessEnv {
  if (!ownedDef || !allocatedPorts) return { ...env };
  const out: NodeJS.ProcessEnv = { ...env };

  // single-port: snapshot stores it under `default`
  if (typeof ownedDef.port === "object" && ownedDef.port?.env) {
    const port = allocatedPorts.default;
    if (port !== undefined) out[ownedDef.port.env] = String(port);
  }

  if (ownedDef.ports) {
    for (const [logical, desc] of Object.entries(ownedDef.ports)) {
      if (typeof desc === "object" && desc?.env) {
        const port = allocatedPorts[logical];
        if (port !== undefined) out[desc.env] = String(port);
      }
    }
  }

  return out;
}
