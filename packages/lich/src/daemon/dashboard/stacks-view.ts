import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ServiceSnapshot, StackSnapshot } from "../../state/snapshot.js";

/** Dashboard-facing projection of a stack snapshot. Stable wire format between REST endpoints and the SPA. */
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
    /** Friendly proxy URL; absent when no routing entry is registered. */
    url?: string;
  }>;
  /** First routing entry's friendly URL — the "open this stack" affordance. */
  primary_url?: string;
  /** Proxy port; always present so clients can build any service URL even when no routing exists yet. */
  proxy_port?: number;
  started_at?: string;
}

/** Sorted by worktree_name; tolerant of missing stateRoot, missing/malformed state.json, and non-directory entries. */
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
  // Build a map of service-name → friendly URL so each service gets
  // its `url` field populated in one pass.
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

  if (snap.active_profile !== undefined) {
    view.active_profile = snap.active_profile;
  }

  // primary_url = first routing entry's friendly URL.
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
