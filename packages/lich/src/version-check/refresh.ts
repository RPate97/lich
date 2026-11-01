import { writeCache } from "./cache.js";

const DEFAULT_RELEASES_URL = "https://github.com/RPate97/lich/releases/latest";
const FETCH_TIMEOUT_MS = 5000;

export async function runRefresh(opts: {
  cachePath: string;
  releasesUrl?: string;
  nowIso?: string;
}): Promise<void> {
  const url = opts.releasesUrl ?? DEFAULT_RELEASES_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    const finalUrl = res.url;
    if (!finalUrl) return;
    const tag = finalUrl.split("/").pop();
    if (!tag || tag === "latest" || tag.length === 0) return;
    const version = tag.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    writeCache(opts.cachePath, {
      checked_at: opts.nowIso ?? new Date().toISOString(),
      latest_version: version,
    });
  } catch {
    // best-effort
  } finally {
    clearTimeout(timer);
  }
}
