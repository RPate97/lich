/**
 * Parse the output of `lich urls` into a structured map.
 *
 * Plan 1 `lich urls` prints one line per allocated host port:
 *   - single-port service:   `<service>: http://localhost:<port>`
 *   - multi-port service:    `<service>.<port-key>: http://localhost:<port>`
 *
 * The parsed shape:
 *   {
 *     api: { default: "http://localhost:4123" },
 *     supabase: {
 *       api: "http://localhost:54321",
 *       db: "http://localhost:54322",
 *       ...
 *     }
 *   }
 *
 * For single-port services we use the key `"default"`; for multi-port
 * services the parsed key matches the `<port-key>` in the line.
 */
export interface ParsedUrls {
  [service: string]: Record<string, string>;
}

const LINE_RE = /^([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?:\s+(\S+)$/;

export function parseLichUrls(stdout: string): ParsedUrls {
  const out: ParsedUrls = {};
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, service, key, url] = m;
    if (!out[service]) out[service] = {};
    out[service][key ?? "default"] = url;
  }
  return out;
}

/**
 * Pull the host port off a `http://host:port[/path]` URL. Returns -1 if the
 * URL doesn't have an explicit port.
 */
export function portFromUrl(url: string): number {
  try {
    const u = new URL(url);
    if (!u.port) return -1;
    return Number(u.port);
  } catch {
    return -1;
  }
}
