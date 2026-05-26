import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Folds every stack's `state.json` routing entries into one in-memory
 * Map keyed by lowercased hostname (RFC 9110 case-insensitivity).
 *
 * Atomic swap on reload — concurrent `get()` callers see either the
 * full old map or the full new one. Last-writer-wins on hostname
 * collisions; tolerates missing / malformed state.json per-stack so
 * one broken stack can't take down the whole table.
 */
export class RoutingTable {
  private entries: Map<string, string> = new Map();

  async reload(stateRoot: string): Promise<void> {
    const next = new Map<string, string>();

    let stackDirs: string[];
    try {
      stackDirs = await readdir(stateRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = next;
        return;
      }
      throw err;
    }

    for (const stackId of stackDirs) {
      const stateFile = join(stateRoot, stackId, "state.json");

      try {
        const s = await stat(join(stateRoot, stackId));
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      let raw: string;
      try {
        raw = await readFile(stateFile, "utf8");
      } catch (err) {
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
        // eslint-disable-next-line no-console
        console.warn(
          `[lich daemon] routing: failed to parse ${stateFile}: ${(err as Error).message}`,
        );
        continue;
      }

      const snapshot = parsed as {
        status?: string;
        routing?: Array<{ hostname?: unknown; upstream_url?: unknown }>;
      };
      // Skip stopped/failed: their listed ports point at nothing —
      // proxying would yield ECONNREFUSED that looks like a proxy bug.
      if (snapshot.status === "stopped" || snapshot.status === "failed") {
        continue;
      }

      const routing = snapshot.routing;
      if (!Array.isArray(routing)) continue;

      for (const entry of routing) {
        if (
          typeof entry.hostname !== "string" ||
          typeof entry.upstream_url !== "string"
        ) {
          continue;
        }
        next.set(entry.hostname.toLowerCase(), entry.upstream_url);
      }
    }

    this.entries = next;
  }

  /** Lowercases the argument; returns undefined on miss. Caller strips `.lich.localhost` suffix first. */
  get(hostname: string): string | undefined {
    return this.entries.get(hostname.toLowerCase());
  }

  size(): number {
    return this.entries.size;
  }

  /** Snapshot the table as a sorted array; caller can keep it across awaits without seeing reload mutations. */
  list(): Array<{ hostname: string; upstream_url: string }> {
    const out: Array<{ hostname: string; upstream_url: string }> = [];
    for (const [hostname, upstream_url] of this.entries) {
      out.push({ hostname, upstream_url });
    }
    out.sort((a, b) => a.hostname.localeCompare(b.hostname));
    return out;
  }
}
