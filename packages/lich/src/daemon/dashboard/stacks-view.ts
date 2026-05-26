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
  }>;
  primary_url?: string;
  started_at?: string;
}

/**
 * Sorted alphabetically by `worktree_name` so list ordering is
 * deterministic. Tolerant of missing stateRoot, missing per-stack
 * state.json, malformed JSON, and non-directory entries.
 */
export async function loadStacksView(stateRoot: string): Promise<StackView[]> {
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

    const view = await readStackView(stateRoot, name);
    if (view !== null) out.push(view);
  }

  out.sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));
  return out;
}

export async function loadStackView(
  stateRoot: string,
  id: string,
): Promise<StackView | null> {
  return readStackView(stateRoot, id);
}

async function readStackView(
  stateRoot: string,
  id: string,
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

  return snapshotToView(id, snapshot);
}

function snapshotToView(id: string, snap: StackSnapshot): StackView {
  const services = snap.services ?? [];
  const view: StackView = {
    id,
    worktree_name: snap.worktree_name,
    status: snap.status,
    started_at: snap.started_at,
    services: services.map((svc) => projectService(svc)),
  };

  // Omit when undefined rather than serializing null.
  if (snap.active_profile !== undefined) {
    view.active_profile = snap.active_profile;
  }

  const primary = derivePrimaryUrl(snap);
  if (primary !== undefined) {
    view.primary_url = primary;
  }

  return view;
}

function projectService(svc: ServiceSnapshot): StackView["services"][number] {
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
  return out;
}

/**
 * Routing-only: the friendly-URL list is the dashboard's source of
 * truth for "primary URL". Intentionally NOT falling back to allocated
 * ports — a stack with no friendly URLs registered (down/never-up)
 * gets no clickable link.
 */
function derivePrimaryUrl(snap: StackSnapshot): string | undefined {
  if (!Array.isArray(snap.routing) || snap.routing.length === 0) {
    return undefined;
  }
  const first = snap.routing[0];
  if (typeof first.upstream_url !== "string" || first.upstream_url.length === 0) {
    return undefined;
  }
  return first.upstream_url;
}
