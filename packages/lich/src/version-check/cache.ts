import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CacheEntry {
  checked_at: string;
  latest_version: string;
}

export function readCache(path: string): CacheEntry | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.checked_at !== "string" || typeof obj.latest_version !== "string") return null;
    return { checked_at: obj.checked_at, latest_version: obj.latest_version };
  } catch {
    return null;
  }
}

export function writeCache(path: string, entry: CacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry), { mode: 0o600 });
}

export function isCacheStale(entry: CacheEntry, maxAgeMs: number, nowMs: number): boolean {
  const checkedMs = Date.parse(entry.checked_at);
  if (!Number.isFinite(checkedMs)) return true;
  return nowMs - checkedMs > maxAgeMs;
}

export function defaultCachePath(env: NodeJS.ProcessEnv): string {
  const base = env.LICH_HOME ?? join(homedir(), ".lich");
  return join(base, "latest-check.json");
}
