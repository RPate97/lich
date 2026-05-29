export interface UrlMap {
  [key: string]: string;
}

/**
 * Parse `lich urls` output into a key → URL map. Handles both friendly URLs
 * (`api: http://api.<wt>.lich.localhost:3300/`) and `--raw` output
 * (`api: http://127.0.0.1:9014/`). Multi-port entries (`supabase (api): ...`)
 * are keyed as `service.portkey`.
 */
export function parseLichUrls(stdout: string): UrlMap {
  const result: UrlMap = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(
      /^([a-z0-9_-]+)(?:\s+\(([a-z0-9_-]+)\))?\s*:\s*(https?:\/\/\S+)$/,
    );
    if (!m) continue;

    const [, service, portKey, url] = m;
    const key = portKey ? `${service}.${portKey}` : service;
    result[key] = url;
  }
  return result;
}

/** Pull the host port off a `http://host:port[/path]` URL. */
export function portFromUrl(url: string): number {
  const m = url.match(/:(\d+)/);
  if (!m) throw new Error(`no port in URL: ${url}`);
  return parseInt(m[1], 10);
}
