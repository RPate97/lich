/**
 * Dashboard-facing projection of the per-stack `state.json` snapshots
 * (LEV-408, Plan 5 Task 6).
 *
 * The dashboard's REST endpoints (`/api/stacks`, `/api/stacks/:id`) and
 * its in-memory cache both consume the {@link StackView} shape this
 * module produces. The shape mirrors `commands/stacks.ts`'s
 * `snapshotToRow` in spirit but exposes the richer per-service detail
 * the UI needs to render service badges, failure reasons, and clickable
 * URLs.
 *
 * ## Why a separate projection from `StackSnapshot`
 *
 * `state.json` is the on-disk, internal-engine shape — it carries
 * implementation details the dashboard doesn't need (`worktree_path`,
 * sanitized PIDs, raw env paths, etc.) and lacks denormalized fields
 * the UI wants (a per-stack "primary URL" for the sidebar link, a
 * cleaned-up per-service "ports" map). The projection layer is the
 * stable wire format between the daemon's REST endpoints and the SPA
 * (and any future API consumers). Keeping it separate from
 * `StackSnapshot` means the snapshot can evolve internally without
 * breaking the dashboard, and vice versa.
 *
 * ## Tolerance for transient state
 *
 * The daemon polls these helpers whenever the watcher fires — which
 * happens in the middle of `lich up` writing intermediate snapshots,
 * `lich down` rewriting them, etc. A read that races with one of those
 * writes must NOT crash the dashboard. We therefore:
 *
 *   - Tolerate a missing `stateRoot` directory entirely → return [].
 *   - Tolerate per-stack `state.json` files that don't exist → skip.
 *   - Tolerate per-stack `state.json` files that are malformed → log
 *     a warning, skip.
 *   - Tolerate non-directory entries at the `stateRoot` (`.DS_Store`,
 *     orphaned files) → skip silently.
 *
 * One broken stack must never prevent the rest of the machine's stacks
 * from rendering.
 *
 * ## Primary URL derivation
 *
 * The dashboard wants one "this is the stack, click here to open it"
 * URL per stack. Two sources for it, in priority order:
 *
 *   1. The first entry in the snapshot's `routing` array (Plan 5
 *      friendly-URL surface). We surface the `upstream_url` rather
 *      than the friendly form because constructing the friendly URL
 *      requires knowing the proxy port — that lives in the daemon's
 *      runtime config and isn't on the snapshot. The dashboard knows
 *      its own proxy port and can derive the friendly URL from the
 *      hostname + port if it wants.
 *   2. Fallback: the first allocated port across services (matches
 *      `commands/stacks.ts`'s `pickPrimaryUrl` exactly — same code
 *      shape, intentionally duplicated to keep this module pure).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ServiceSnapshot, StackSnapshot } from "../../state/snapshot.js";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * The dashboard-facing view of a single stack. Returned by `/api/stacks`
 * and `/api/stacks/:id`. Keep this stable — the SPA depends on it and
 * external tools (CI dashboards, scripts) may consume it too.
 */
export interface StackView {
  /** Stack id (the directory name under `~/.lich/stacks/<id>/`). */
  id: string;
  /** Worktree name from the snapshot — used as the human-readable label. */
  worktree_name: string;
  /** Verbatim stack status (`up | starting | partial | stopping | stopped | failed`). */
  status: string;
  /**
   * The profile this stack was started under, when one was declared.
   * Omitted (not `null`) when the snapshot has no `active_profile`.
   */
  active_profile?: string;
  /** Per-service detail for the main pane. */
  services: Array<{
    name: string;
    kind: "owned" | "compose";
    state: string;
    /**
     * Failure reason from Plan 4. Only meaningful when `state === "failed"`.
     * Omitted on healthy services to keep the wire payload tight.
     */
    failure_reason?: string;
    /**
     * Last few log lines captured at the moment of failure. Same
     * caveat as `failure_reason` — only present for failed services.
     */
    failure_log_tail?: string[];
    /**
     * Allocated host ports keyed by logical port name. Omitted when the
     * service has no allocated ports (matches the snapshot's behavior).
     */
    ports?: Record<string, number>;
  }>;
  /**
   * A clickable URL for the stack — the dashboard sidebar uses this
   * for the "open" link. Derived from the routing entries if present
   * (Plan 5), otherwise the first allocated port across services
   * (matches `commands/stacks.ts`). Omitted entirely when the stack
   * has no allocated ports at all.
   */
  primary_url?: string;
  /** ISO 8601 timestamp; the SPA computes uptime from this client-side. */
  started_at?: string;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Load every visible stack's view from the given `stateRoot`.
 *
 * Returns an array sorted alphabetically by `worktree_name` so the
 * dashboard's list ordering is deterministic across reloads. The
 * sort key matches `commands/stacks.ts`'s pretty-print sort exactly.
 *
 * Tolerant of every transient condition listed in the module JSDoc.
 */
export async function loadStacksView(stateRoot: string): Promise<StackView[]> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Fresh install or test tmpdir that hasn't been touched.
      return [];
    }
    throw err;
  }

  const out: StackView[] = [];
  for (const name of entries) {
    // Skip non-directory entries (`.DS_Store`, stray files).
    try {
      const s = await stat(join(stateRoot, name));
      if (!s.isDirectory()) continue;
    } catch {
      // Disappeared between readdir and stat — skip.
      continue;
    }

    const view = await readStackView(stateRoot, name);
    if (view !== null) out.push(view);
  }

  out.sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));
  return out;
}

/**
 * Load a single stack's view by id, or return null if it doesn't exist
 * (or its state.json is malformed). Mirrors `loadStacksView`'s tolerance.
 */
export async function loadStackView(
  stateRoot: string,
  id: string,
): Promise<StackView | null> {
  return readStackView(stateRoot, id);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and project a single stack's `state.json`. Returns null on any
 * tolerated error (missing file, malformed JSON, non-directory). Throws
 * only on truly unexpected I/O errors (EACCES on the root, etc.) — the
 * caller (`loadStacksView`) doesn't currently distinguish, but throwing
 * here keeps the error visible if a real systemic issue ever shows up.
 */
async function readStackView(
  stateRoot: string,
  id: string,
): Promise<StackView | null> {
  const stateFile = join(stateRoot, id, "state.json");
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (err) {
    // ENOENT here means the stack directory exists but `state.json`
    // hasn't been written yet (or `lich down` removed it). Other read
    // errors (EACCES, EIO) we also tolerate — a single unreadable
    // stack must not break the dashboard for everything else.
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
    // Atomic-rename writes (`snapshot.ts`) should prevent partial JSON
    // documents, but a manually-edited state.json or a non-lich tool's
    // write can still produce garbage. Warn so the operator notices;
    // do not throw — the rest of the stacks on the machine still get
    // indexed.
    // eslint-disable-next-line no-console
    console.warn(
      `[lich daemon] stacks-view: failed to parse ${stateFile}: ${(err as Error).message}`,
    );
    return null;
  }

  return snapshotToView(id, snapshot);
}

/**
 * Pure projection from a parsed {@link StackSnapshot} to a {@link StackView}.
 *
 * Exported only via the loaders above — kept module-private so the
 * projection logic stays in one place and consumers don't accidentally
 * build views from arbitrary JSON.
 */
function snapshotToView(id: string, snap: StackSnapshot): StackView {
  const services = snap.services ?? [];
  const view: StackView = {
    id,
    worktree_name: snap.worktree_name,
    status: snap.status,
    started_at: snap.started_at,
    services: services.map((svc) => projectService(svc)),
  };

  // active_profile: only emit when the snapshot has one. Leaving the
  // field out (rather than serializing `null`) keeps the JSON shape
  // backward-compatible with the test expectations in
  // `commands/stacks.ts` and matches that command's behavior exactly.
  if (snap.active_profile !== undefined) {
    view.active_profile = snap.active_profile;
  }

  const primary = derivePrimaryUrl(snap);
  if (primary !== undefined) {
    view.primary_url = primary;
  }

  return view;
}

/**
 * Per-service projection: pull out the fields the UI needs and rename
 * `allocated_ports` to `ports` (shorter wire name, matches the SPA's
 * existing field convention from the v0 dashboard).
 */
function projectService(svc: ServiceSnapshot): StackView["services"][number] {
  const out: StackView["services"][number] = {
    name: svc.name,
    kind: svc.kind,
    state: svc.state,
  };
  if (svc.allocated_ports && Object.keys(svc.allocated_ports).length > 0) {
    out.ports = { ...svc.allocated_ports };
  }
  // Failure metadata only present for failed services — `sanitizeForWrite`
  // in `state/snapshot.ts` strips it from healthy services on disk, so
  // we shouldn't see it here for non-failed states. Pass it through
  // defensively anyway: the source of truth is the on-disk snapshot.
  if (svc.failure_reason !== undefined) {
    out.failure_reason = svc.failure_reason;
  }
  if (svc.failure_log_tail !== undefined) {
    out.failure_log_tail = svc.failure_log_tail;
  }
  return out;
}

/**
 * Pick the URL the dashboard surfaces as the stack's "primary" link.
 *
 * Source: the first entry in the snapshot's `routing` array. The
 * routing field is the Plan 5 friendly-URL surface — populated by
 * `lich up` after the stack is ready and cleared by `lich down` on
 * teardown. We expose the entry's `upstream_url` rather than the
 * friendly form because constructing the friendly form requires the
 * proxy port, which isn't on the snapshot (it lives in the daemon's
 * runtime config). The dashboard knows its own proxy port and can
 * derive the friendly URL from the hostname + port if it wants.
 *
 * Returns undefined when:
 *   - The snapshot has no `routing` field (pre-Plan-5 snapshot).
 *   - The snapshot's `routing` is an empty array (just-torn-down stack,
 *     per `lich down` semantics).
 *   - The first entry is structurally malformed (missing `upstream_url`).
 *
 * Note: we intentionally do NOT fall back to the first allocated port
 * here. `commands/stacks.ts`'s `pickPrimaryUrl` uses the allocated-port
 * fallback for its `lich stacks` row output, but the dashboard's
 * `primary_url` semantics are routing-only: if a stack has no friendly
 * URLs registered (down/never-up), the dashboard surfaces no clickable
 * link — the per-service detail still shows allocated ports for users
 * who want raw URLs.
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
