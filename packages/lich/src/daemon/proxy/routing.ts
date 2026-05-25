/**
 * Daemon-side routing table for the friendly-URL reverse proxy
 * (LEV-413, Plan 5 Task 11).
 *
 * The lich daemon hosts a single reverse proxy on `runtime.proxy_port`
 * (default 3300). The proxy routes incoming requests by `Host` header to
 * the right per-stack upstream — e.g. `http://api.feature-x.lich.localhost:3300/`
 * maps to whatever localhost port `api` was allocated in the `feature-x`
 * worktree's stack.
 *
 * The mapping lives on-disk: each stack's `state.json` carries a
 * `routing` array (see `state/snapshot.ts`'s `RoutingEntry`) populated by
 * `lich up` once the stack is ready and cleared by `lich down` on
 * teardown. This module is the daemon-side reader: glob every `state.json`
 * under the state root, fold the routing arrays into a single in-memory
 * Map keyed by hostname, and expose case-insensitive lookup.
 *
 * ## Discovery is on-disk, not IPC
 *
 * Stacks and the daemon don't talk to each other over a socket. The
 * watcher (`daemon/watcher.ts`) notices when any `state.json` under the
 * state root changes, and the daemon calls `reload()` to rebuild the
 * table from scratch. Rebuilds are cheap at our scale (≤ tens of stacks,
 * each with ≤ tens of services); we don't bother with incremental
 * updates.
 *
 * ## Case-insensitive lookup (RFC 9110)
 *
 * Hostnames in HTTP requests are case-insensitive. A browser may send
 * `Host: API.FEATURE-X.lich.localhost:3300` even when the user typed the
 * lowercase form. We normalize both the stored keys and the lookup
 * argument to lowercase so the proxy never misses a route over case.
 *
 * ## Last-writer-wins on collisions
 *
 * If two stacks somehow both claim `api.feature-x`, the second one read
 * (filesystem iteration order — effectively undefined) wins. This isn't
 * a great outcome but it's a degenerate case that shouldn't happen in
 * normal use: each stack is namespaced by its worktree name, and
 * worktree names are unique per machine. We collapse silently rather
 * than logging or throwing — the daemon stays quiet about a state the
 * user can't observe directly.
 *
 * ## Tolerance for missing / malformed state.json
 *
 * Reading a state.json that doesn't exist (race with `lich down`
 * deleting a directory), can't be parsed (truncated mid-write — though
 * `snapshot.ts`'s atomic rename should prevent this), or lacks a
 * `routing` field (pre-Plan-5 snapshots) is silently tolerated. We log
 * a console warning on parse failure to aid debugging but never throw —
 * a single broken stack must not prevent the proxy from serving routes
 * for every other stack on the machine.
 *
 * ## WebSocket limitation (documented per spec acceptance criteria)
 *
 * The proxy is HTTP-only for v1. WebSocket upgrades (`Upgrade: websocket`
 * header) are not supported and will return 404 from the proxy. The
 * documented escape hatch is `lich urls --raw`, which prints the
 * underlying `localhost:<port>` URLs that bypass the proxy. See the
 * spec section "Friendly URLs" for the rationale.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * In-memory snapshot of every active routing entry across every stack
 * on the machine. Built by `reload()`; queried by `get()`. The proxy
 * holds a single instance; the daemon calls `reload()` from the
 * `StateWatcher`'s `onChange` callback.
 *
 * Not thread-safe in the strictest sense — but Bun is single-threaded
 * per worker, and `reload()` builds the new map locally before swapping
 * it in atomically, so an in-flight `get()` either sees the entire
 * previous state or the entire next one. Never a half-rebuilt table.
 */
export class RoutingTable {
  /**
   * Hostname (lowercased) -> upstream URL. Replaced atomically by
   * `reload()` so concurrent `get()` callers never observe a partial
   * table.
   */
  private entries: Map<string, string> = new Map();

  /**
   * Walk `<stateRoot>/<stack-id>/state.json` for every stack on the
   * machine, parse each, and rebuild the routing table from scratch.
   *
   * - Missing `stateRoot` (fresh install, no `lich up` yet) → table
   *   becomes empty, no error.
   * - Missing per-stack `state.json` (race with `lich down`) → that
   *   stack contributes nothing, no error.
   * - Malformed `state.json` → logged to stderr, stack contributes
   *   nothing, no error.
   * - `routing` field absent on a snapshot (pre-Plan-5) → stack
   *   contributes nothing, no error.
   * - `routing: []` → stack contributes nothing (the cleared-on-down
   *   case from `snapshot.ts`'s docs).
   *
   * Hostnames are stored lowercase to support RFC 9110 case-insensitive
   * lookup.
   */
  async reload(stateRoot: string): Promise<void> {
    const next = new Map<string, string>();

    let stackDirs: string[];
    try {
      stackDirs = await readdir(stateRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Fresh install or test tmpdir that hasn't been touched. Empty
        // table is the right answer.
        this.entries = next;
        return;
      }
      throw err;
    }

    for (const stackId of stackDirs) {
      const stateFile = join(stateRoot, stackId, "state.json");

      // Skip non-directories (stray files at the root). `state.json`
      // only lives one level deep — directly under `<stateRoot>/<stack-id>/`.
      try {
        const s = await stat(join(stateRoot, stackId));
        if (!s.isDirectory()) continue;
      } catch {
        // Disappeared between readdir and stat — skip.
        continue;
      }

      let raw: string;
      try {
        raw = await readFile(stateFile, "utf8");
      } catch (err) {
        // ENOENT here just means the stack directory exists but
        // state.json hasn't been written yet (or has been deleted by
        // `lich down`). Other errors (EACCES, EIO) we also tolerate —
        // a single unreadable stack must not break the whole table.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // eslint-disable-next-line no-console
          console.warn(
            `[lich daemon] routing: failed to read ${stateFile}: ${(err as Error).message}`,
          );
        }
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Atomic-rename writes should prevent partial documents, but
        // a manually-edited state.json or a non-lich tool's write can
        // still produce garbage. Warn so the operator notices; don't
        // throw.
        // eslint-disable-next-line no-console
        console.warn(
          `[lich daemon] routing: failed to parse ${stateFile}: ${(err as Error).message}`,
        );
        continue;
      }

      // Filter out routes for stacks that aren't actually serving
      // traffic. A `stopped` or `failed` stack's listed ports point at
      // nothing — proxying to them would yield connection-refused
      // errors that look (to the user) like a proxy bug. Pre-Plan-5
      // snapshots with no `status` are treated as live (back-compat
      // safety).
      const snapshot = parsed as {
        status?: string;
        routing?: Array<{ hostname?: unknown; upstream_url?: unknown }>;
      };
      if (snapshot.status === "stopped" || snapshot.status === "failed") {
        continue;
      }

      const routing = snapshot.routing;
      if (!Array.isArray(routing)) continue;

      for (const entry of routing) {
        // Defensive: an entry missing either field is ignored. This is
        // a malformed snapshot — we already warn on parse failures, so
        // a structural omission inside a parseable doc just means the
        // entry is silently skipped.
        if (
          typeof entry.hostname !== "string" ||
          typeof entry.upstream_url !== "string"
        ) {
          continue;
        }
        // Last-writer-wins on collisions. See module JSDoc for why.
        next.set(entry.hostname.toLowerCase(), entry.upstream_url);
      }
    }

    // Atomic swap — concurrent `get()` callers see either the old map
    // or the new one, never an intermediate state.
    this.entries = next;
  }

  /**
   * Look up the upstream URL for a hostname.
   *
   * The argument is lowercased before lookup so the caller doesn't have
   * to normalize. Returns `undefined` if no route matches.
   *
   * The caller is responsible for stripping the `.lich.localhost(:port)?`
   * suffix from the raw `Host` header before calling — this method
   * doesn't know about the proxy's hostname schema.
   */
  get(hostname: string): string | undefined {
    return this.entries.get(hostname.toLowerCase());
  }

  /**
   * Number of routing entries currently indexed. Surfaced for tests
   * and operational observability (e.g. a future `/healthz` endpoint
   * that wants to report "proxy is serving N routes").
   */
  size(): number {
    return this.entries.size;
  }
}
