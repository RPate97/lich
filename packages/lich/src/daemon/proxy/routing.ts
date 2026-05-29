import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** In-memory map of lowercased hostname → upstream URL, atomically swapped on reload. Last-writer-wins on collisions. */
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
      // Skip stopped/failed — their listed ports point at nothing, so
      // proxying yields ECONNREFUSED that looks like a proxy bug.
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

  /** Lowercases the argument. Caller strips `.lich.localhost` suffix first. */
  get(hostname: string): string | undefined {
    return this.entries.get(hostname.toLowerCase());
  }

  size(): number {
    return this.entries.size;
  }

  /** Sorted snapshot; safe to retain across awaits without seeing reload mutations. */
  list(): Array<{ hostname: string; upstream_url: string }> {
    const out: Array<{ hostname: string; upstream_url: string }> = [];
    for (const [hostname, upstream_url] of this.entries) {
      out.push({ hostname, upstream_url });
    }
    out.sort((a, b) => a.hostname.localeCompare(b.hostname));
    return out;
  }
}
