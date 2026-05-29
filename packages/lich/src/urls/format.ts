/**
 * Shared URL-formatting helpers for `lich up`'s success summary and
 * `lich urls`. Both surfaces present the same set of user-facing URLs;
 * keeping the formatting in one place ensures the two commands stay in
 * lockstep when the friendly-URL convention evolves.
 *
 * Two output flavors:
 *
 *   - Friendly (default for both `lich up` and `lich urls`): proxied URLs
 *     of the form `http://<service>.<worktree>.lich.localhost:<proxy-port>/`
 *     for single-port services and
 *     `http://<service>-<key>.<worktree>.lich.localhost:<proxy-port>/` for
 *     multi-port services. Built from the snapshot's `routing` entries
 *     (populated by `lich up`'s `buildRoutingEntries` once a stack is
 *     ready).
 *
 *   - Raw (`--raw` on both commands): direct upstream URLs of the form
 *     `http://127.0.0.1:<port>` against the service's allocated host
 *     port(s). Plan-1 behavior, kept as the escape hatch for users who
 *     can't or don't want to use `*.lich.localhost` (corporate DNS / VPN
 *     shadowing the apex, non-HTTP debug tooling, etc.).
 *
 * Hostname conventions (set by `up.ts#buildRoutingEntries`, mirrored here
 * in `formatFriendlyUrl`):
 *
 *   - Single port: `<service>.<worktree>` → routes to one port.
 *   - Multi-port:  `<service>-<key>.<worktree>` → one entry per port key,
 *     dash-separated (not dot-separated) because `*.lich.localhost` binds
 *     only one level of subdomain.
 *
 * The shared helpers do NOT touch the filesystem and do NOT consult the
 * yaml — callers pass in the snapshot's per-service `allocated_ports` and
 * the resolved proxy port. This keeps the module trivially unit-testable
 * and reusable from the `lich up` summary path (which already has the
 * data in-memory) without re-reading state.json.
 */

import type { RoutingEntry, ServiceSnapshot } from "../state/snapshot.js";

/**
 * Default proxy port for friendly URLs. The lich daemon binds 3300 by
 * default (see `daemon/daemon.ts`). When the caller has access to the
 * resolved `runtime.proxy_port` from `lich.yaml`, that value wins;
 * otherwise this constant is the fallback. Both `lich up` and `lich
 * urls` import this so the default value lives in exactly one place.
 */
export const DEFAULT_PROXY_PORT = 3300;

/**
 * One user-facing URL line. The shared shape used by both `lich up`'s
 * summary block (where the renderer emits a service-name column + URL
 * column) and `lich urls` (where each line is printed verbatim).
 */
export interface FormattedUrl {
  /**
   * Service name as declared in `services:` / `owned:`. The renderer
   * uses this for the service-name column; line-printers use it as the
   * `<service>:` prefix.
   */
  service: string;
  /**
   * Optional logical port key for multi-port services. Single-port
   * services leave this undefined. Renderers that want to print
   * `service (key)` (the `lich urls` line shape) consult this; the
   * summary-block renderer ignores it because the service column is
   * already wide enough to disambiguate via repetition.
   */
  key?: string;
  /** The reachable URL — friendly or raw, depending on caller's flag. */
  url: string;
}

/**
 * Build the friendly URL for a single routing entry.
 *
 * Mirrors `formatFriendlyLine` in `commands/urls.ts` so both commands
 * produce identical URLs for identical routing entries. Returns just the
 * URL (with trailing slash) — the caller chooses how to label/render it.
 */
export function formatFriendlyUrl(
  entry: RoutingEntry,
  proxyPort: number,
): string {
  return `http://${entry.hostname}.lich.localhost:${proxyPort}/`;
}

/**
 * Extract the port-key suffix from a multi-port routing entry's
 * hostname, or null when the entry is single-port.
 *
 * Hostname conventions (set by `up.ts#buildRoutingEntries`):
 *   - Single port: `<service>.<worktree>` → no key
 *   - Multi-port:  `<service>-<key>.<worktree>` → key between `<service>-`
 *     and the first `.`
 *
 * Detection: if the hostname starts with `<service>-`, everything between
 * that and the first `.` is the port key. If it starts with `<service>.`
 * (no dash), it's single-port. We avoid splitting on `.` because the
 * worktree name itself is `[a-z0-9-]+` and may contain dashes — splitting
 * on dashes would over-eagerly chop the worktree name.
 *
 * Defensive fallback: if neither prefix matches (shouldn't happen for any
 * entry the orchestrator writes, but possible if a future writer reshapes
 * the hostname), returns null and the caller treats it as single-port.
 */
export function extractKey(entry: RoutingEntry): string | null {
  const dashPrefix = `${entry.service}-`;
  if (entry.hostname.startsWith(dashPrefix)) {
    const afterPrefix = entry.hostname.slice(dashPrefix.length);
    const dotIdx = afterPrefix.indexOf(".");
    return dotIdx === -1 ? afterPrefix : afterPrefix.slice(0, dotIdx);
  }
  return null;
}

/**
 * Build the friendly URL list from a snapshot's routing entries +
 * resolved proxy port. The shape (`FormattedUrl[]`) is consumed by both
 * `lich up`'s summary builder and `lich urls`'s output writer.
 *
 * Order is preserved from the input — callers that want a specific order
 * (e.g. yaml-declaration order) should pass entries in that order. The
 * orchestrator's `buildRoutingEntries` iterates services in snapshot
 * insertion order, which mirrors the yaml's declared order, so callers
 * passing `snapshot.routing` get the user-facing order for free.
 */
export function buildFriendlyUrls(
  routing: readonly RoutingEntry[],
  proxyPort: number,
): FormattedUrl[] {
  return routing.map((entry) => {
    const key = extractKey(entry);
    const url = formatFriendlyUrl(entry, proxyPort);
    return key === null
      ? { service: entry.service, url }
      : { service: entry.service, key, url };
  });
}

/**
 * Build the raw URL list from per-service allocated-port maps. Mirrors
 * `appendRawServiceLines` in `commands/urls.ts` so both commands produce
 * identical URLs in `--raw` mode.
 *
 * - 1 logical port:  `<service>: http://127.0.0.1:<port>` (no key)
 * - N logical ports: one `FormattedUrl` per port, with `key` set
 *
 * The single-vs-multi distinction is based purely on the number of
 * entries in `allocated_ports`, NOT on the original config shape
 * (`port:` vs `ports:`). A multi-port service that happens to have only
 * one allocated port still prints in single-port form — the raw output
 * is purely about what's reachable on localhost.
 *
 * 127.0.0.1 rather than `localhost` to dodge Docker IPv6 hijack on macOS.
 * Friendly URLs use `.lich.localhost` which Bun resolves correctly; raw URLs
 * need the explicit IPv4 to be useful for scripts that fetch them.
 *
 * Services with no allocated ports are skipped — there's nothing to
 * print. Callers wanting to render a "no ports allocated" message
 * detect an empty return value and print their own placeholder.
 */
export function buildRawUrls(
  services: readonly ServiceSnapshot[],
): FormattedUrl[] {
  const out: FormattedUrl[] = [];
  for (const svc of services) {
    const allocated = svc.allocated_ports;
    if (!allocated) continue;

    const entries = Object.entries(allocated);
    if (entries.length === 0) continue;

    if (entries.length === 1) {
      const port = entries[0][1];
      out.push({ service: svc.name, url: `http://127.0.0.1:${port}` });
      continue;
    }

    for (const [key, port] of entries) {
      out.push({
        service: svc.name,
        key,
        url: `http://127.0.0.1:${port}`,
      });
    }
  }
  return out;
}

/**
 * Format a `FormattedUrl` as one line for `lich urls`. Single-port
 * entries print `<service>: <url>`; multi-port entries print
 * `<service> (<key>): <url>` (friendly) or `<service>.<key>: <url>` (raw).
 *
 * The `style` argument picks between the two key formats. Both shapes are
 * what users have come to expect from the respective commands; conflating
 * them would break existing scripts and muscle memory.
 */
export function formatUrlLine(
  url: FormattedUrl,
  style: "friendly" | "raw",
): string {
  if (url.key === undefined) {
    return `${url.service}: ${url.url}`;
  }
  const sep = style === "friendly" ? ` (${url.key})` : `.${url.key}`;
  return `${url.service}${sep}: ${url.url}`;
}
