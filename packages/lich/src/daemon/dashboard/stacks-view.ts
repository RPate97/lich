import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ServiceSnapshot, StackSnapshot } from "../../state/snapshot.js";

/**
 * Dashboard-facing projection of a stack snapshot. Stable wire format
 * between the daemon's REST endpoints and the SPA — keep backwards-
 * compatible; the on-disk `StackSnapshot` can evolve independently.
 */
export interface StackView {
  id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services: Array<{
    name: string;
    kind: "owned" | "compose";
    state: string;
    failure_reason?: string;
    failure_log_tail?: string[];
    ports?: Record<string, number>;
    /**
     * Friendly URL served by the daemon's reverse proxy
     * (`http://<service>.<worktree>.lich.localhost:<proxy-port>/`).
     * Populated only when the service has a routing entry registered —
     * absent during startup, after shutdown, or when the service exposes
     * no ports. Same proxy port across every service in a stack.
     */
    url?: string;
  }>;
  /**
   * Friendly URL for the stack as a whole — first routing entry's
   * friendly URL. Same format as the per-service `url`. Surface in the
   * sidebar / header as the "open this stack" affordance.
   */
  primary_url?: string;
  /**
   * TCP port the daemon's reverse proxy is listening on. Always
   * present; clients can build any service URL via
   * `http://<service>.<worktree>.lich.localhost:${proxy_port}/` even
   * when no routing entries are registered yet.
   */
  proxy_port?: number;
  started_at?: string;
}

/**
 * Sorted alphabetically by `worktree_name` so list ordering is
 * deterministic. Tolerant of missing stateRoot, missing per-stack
 * state.json, malformed JSON, and non-directory entries.
 *
 * `proxyPort` is the daemon's reverse-proxy port; threaded in so each
 * service's friendly URL (`http://<service>.<worktree>.lich.localhost:<port>/`)
 * can be computed server-side. The SPA reads `service.url` / `primary_url`
 * directly rather than reconstructing the friendly form from the upstream.
 */
export async function loadStacksView(
  stateRoot: string,
  proxyPort: number,
): Promise<StackView[]> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const out: StackView[] = [];
  for (const name of entries) {
    try {
      const s = await stat(join(stateRoot, name));
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const view = await readStackView(stateRoot, name, proxyPort);
    if (view !== null) out.push(view);
  }

  out.sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));
  return out;
}

export async function loadStackView(
  stateRoot: string,
  id: string,
  proxyPort: number,
): Promise<StackView | null> {
  return readStackView(stateRoot, id, proxyPort);
}

async function readStackView(
  stateRoot: string,
  id: string,
  proxyPort: number,
): Promise<StackView | null> {
  const stateFile = join(stateRoot, id, "state.json");
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn(
        `[lich daemon] stacks-view: failed to read ${stateFile}: ${(err as Error).message}`,
      );
    }
    return null;
  }

  let snapshot: StackSnapshot;
  try {
    snapshot = JSON.parse(raw) as StackSnapshot;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[lich daemon] stacks-view: failed to parse ${stateFile}: ${(err as Error).message}`,
    );
    return null;
  }

  return snapshotToView(id, snapshot, proxyPort);
}

function snapshotToView(
  id: string,
  snap: StackSnapshot,
  proxyPort: number,
): StackView {
  const services = snap.services ?? [];
  // Build a map service-name → friendly URL so each projected service
  // gets its `url` field populated in one pass. Only services with a
  // routing entry registered get a URL — starting / stopped / no-ports
  // services come back without one (the SPA renders them as inert rows).
  const routing = Array.isArray(snap.routing) ? snap.routing : [];
  const urlByService = new Map<string, string>();
  for (const entry of routing) {
    if (
      typeof entry.service === "string" &&
      typeof entry.hostname === "string" &&
      entry.hostname.length > 0
    ) {
      urlByService.set(
        entry.service,
        `http://${entry.hostname}.lich.localhost:${proxyPort}/`,
      );
    }
  }

  const view: StackView = {
    id,
    worktree_name: snap.worktree_name,
    status: snap.status,
    started_at: snap.started_at,
    services: services.map((svc) => projectService(svc, urlByService)),
    proxy_port: proxyPort,
  };

  // Omit when undefined rather than serializing null.
  if (snap.active_profile !== undefined) {
    view.active_profile = snap.active_profile;
  }

  // Stack-level primary URL = first routing entry's friendly URL.
  // Preserves the "first routing entry wins" rule from the legacy upstream
  // form; sidebar / header consumers get a clickable proxy URL rather than
  // a raw `http://127.0.0.1:<port>`.
  if (routing.length > 0) {
    const first = routing[0];
    if (typeof first.hostname === "string" && first.hostname.length > 0) {
      view.primary_url = `http://${first.hostname}.lich.localhost:${proxyPort}/`;
    }
  }

  return view;
}

function projectService(
  svc: ServiceSnapshot,
  urlByService: Map<string, string>,
): StackView["services"][number] {
  const out: StackView["services"][number] = {
    name: svc.name,
    kind: svc.kind,
    state: svc.state,
  };
  if (svc.allocated_ports && Object.keys(svc.allocated_ports).length > 0) {
    out.ports = { ...svc.allocated_ports };
  }
  if (svc.failure_reason !== undefined) {
    out.failure_reason = svc.failure_reason;
  }
  if (svc.failure_log_tail !== undefined) {
    out.failure_log_tail = svc.failure_log_tail;
  }
  const url = urlByService.get(svc.name);
  if (url !== undefined) {
    out.url = url;
  }
  return out;
}
