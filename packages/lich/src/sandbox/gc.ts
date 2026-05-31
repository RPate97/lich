import type { GoldenManifest } from './snapshot-store.js';

export interface GcPolicy {
  keepPerProfile: number;
  maxTotalBytes: number;
}

// Pure selection of goldens to evict. Rule 1: beyond the most-recent N per
// profile are candidates. Rule 2: if total size still exceeds the cap, oldest
// remaining become candidates. A golden with a live fork is NEVER evicted
// (keep-on-uncertainty).
export function selectGoldensToEvict(
  goldens: ReadonlyArray<GoldenManifest>,
  liveGoldenHashes: ReadonlySet<string>,
  policy: GcPolicy,
): GoldenManifest[] {
  const evict = new Set<string>();

  const byProfile = new Map<string, GoldenManifest[]>();
  for (const g of goldens) {
    const arr = byProfile.get(g.profileName) ?? [];
    arr.push(g);
    byProfile.set(g.profileName, arr);
  }
  for (const arr of byProfile.values()) {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const g of arr.slice(policy.keepPerProfile)) {
      if (!liveGoldenHashes.has(g.inputsHash)) evict.add(g.inputsHash);
    }
  }

  const survivors = goldens
    .filter((g) => !evict.has(g.inputsHash))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let total = survivors.reduce((s, g) => s + (g.sizeBytes ?? 0), 0);
  for (const g of survivors) {
    if (total <= policy.maxTotalBytes) break;
    if (liveGoldenHashes.has(g.inputsHash)) continue;
    evict.add(g.inputsHash);
    total -= g.sizeBytes ?? 0;
  }

  return goldens.filter((g) => evict.has(g.inputsHash));
}
