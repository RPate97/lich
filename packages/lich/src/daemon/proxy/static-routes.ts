/**
 * Static (non-stack) routes for the lich reverse proxy (LEV-481).
 *
 * The proxy's main job is to route per-stack friendly URLs
 * (`http://<service>.<worktree>.lich.localhost:3300/`) to per-stack
 * upstreams. Those routes come from `RoutingTable`, which reloads from
 * every stack's `state.json` on every state change.
 *
 * BUT there's exactly one daemon-wide service that needs a friendly URL
 * too: the dashboard. It lives on an ephemeral port, it's not per-stack,
 * and it has no `state.json` to source a routing entry from. The
 * convention is `http://lich.localhost:3300/` — the clean apex of the
 * proxy domain, matching the spec's "one daemon, one dashboard" model.
 *
 * Rather than hack the dashboard route into `RoutingTable` (which would
 * have to skip-list the magic key on every reload, plus risk a stack
 * accidentally clobbering it), we keep daemon-wide routes in a separate
 * tiny module the proxy consults BEFORE the per-stack routing table.
 *
 * ## Why a separate module
 *
 * Several reasons:
 *
 *   1. **No reload churn.** `RoutingTable.reload()` blows away every
 *      entry and rebuilds from disk. The dashboard route is provided by
 *      the daemon at startup and never changes; threading it through
 *      reload would require either an opt-out flag on the table or a
 *      "static entries" layer underneath the disk entries. Either is
 *      more complexity than a tiny helper that the proxy checks first.
 *
 *   2. **Different hostname grammar.** Per-stack routes match
 *      `<key>.lich.localhost` (subdomain). The dashboard matches the
 *      apex `lich.localhost` exactly — `parseHostname` returns null for
 *      the apex because there's no subdomain to strip. The static-route
 *      matcher handles the apex case naturally without contaminating
 *      the subdomain parser.
 *
 *   3. **Minimal blast radius.** The proxy code touched by LEV-479
 *      (bind code) and LEV-480 (per-stack routing reload) is hot. A
 *      new file with a 30-line matcher is the cheapest possible
 *      surface for a daemon-wide concept; the proxy's existing handler
 *      adds a one-line check.
 *
 * ## Hostname matching
 *
 * Static routes match the FULL host header (minus the `:port` suffix)
 * case-insensitively. There's no subdomain stripping — `lich.localhost`
 * means literally `Host: lich.localhost(:port)`. RFC 9110 says hostnames
 * are case-insensitive; we lowercase both sides to honor that.
 *
 * ## Lifecycle
 *
 * The daemon constructs a `StaticRoutes` once at startup and passes it
 * to `startProxy`. The instance is immutable — once registered, routes
 * don't change for the daemon's lifetime. (A future "register dashboard
 * route conditionally" or "rebind on dashboard port change" is a separate
 * concern; for now the dashboard URL is fixed for the daemon's life.)
 */

/**
 * In-memory daemon-wide route table. Keyed by the lowercased host header
 * (no `:port` suffix); values are the upstream URL to forward to.
 *
 * Construct with {@link createStaticRoutes}; consult via {@link lookup}.
 * The proxy handler is the only consumer.
 */
export interface StaticRoutes {
  /**
   * Look up the upstream URL for a given Host header. Returns undefined
   * when no static route matches.
   *
   * The argument is the RAW header value from the request — this helper
   * strips the `:port` suffix and lowercases internally. Callers don't
   * need to normalize.
   */
  lookup(rawHost: string | null): string | undefined;
  /**
   * Return the routes' canonical (lowercased, port-stripped) hostnames.
   * Exposed for the proxy's 404 body so a misrouted request sees
   * `lich.localhost` listed alongside per-stack friendly hosts.
   */
  hosts(): string[];
}

/**
 * Build a {@link StaticRoutes} from a host → upstream-URL record. The
 * input keys are normalized (lowercased, `:port` stripped if the user
 * accidentally included one) before storage so lookups are O(1) and
 * case-insensitive.
 *
 * An empty record is legal — the resulting routes match nothing and
 * `lookup()` always returns undefined. The daemon uses this shape when
 * the dashboard fails to bind: the proxy still serves per-stack routes;
 * it just has no apex route to advertise.
 */
export function createStaticRoutes(
  entries: Record<string, string>,
): StaticRoutes {
  const normalized = new Map<string, string>();
  for (const [host, upstream] of Object.entries(entries)) {
    const key = host.replace(/:\d+$/, "").toLowerCase();
    if (key.length === 0) continue;
    normalized.set(key, upstream);
  }

  return {
    lookup(rawHost: string | null): string | undefined {
      if (!rawHost) return undefined;
      const key = rawHost.replace(/:\d+$/, "").toLowerCase();
      if (key.length === 0) return undefined;
      return normalized.get(key);
    },
    hosts(): string[] {
      return Array.from(normalized.keys());
    },
  };
}

/**
 * Convenience constructor — an empty static-routes table. The proxy's
 * default when the daemon hasn't supplied one (e.g. early tests, or the
 * dashboard-failed-to-bind branch).
 */
export function emptyStaticRoutes(): StaticRoutes {
  return createStaticRoutes({});
}
