/**
 * Daemon-wide static routes (e.g. apex `lich.localhost` → dashboard).
 * Consulted before the per-stack routing table. Separate layer because
 * the apex doesn't fit `parseHostname`'s subdomain grammar and
 * `RoutingTable.reload()` blows away its entries on every state change.
 */
export interface StaticRoutes {
  /** Argument is the raw Host header; port stripped + lowercased internally. */
  lookup(rawHost: string | null): string | undefined;
  /** Canonical hostnames — used in the proxy's 404 body. */
  hosts(): string[];
}

/** Empty record is legal — every lookup returns undefined. */
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

export function emptyStaticRoutes(): StaticRoutes {
  return createStaticRoutes({});
}
