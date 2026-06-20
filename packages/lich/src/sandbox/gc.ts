import type { SandboxBackend } from './backend.js';
import type { GoldenManifest, SnapshotStore } from './snapshot-store.js';

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

export interface RunGcResult {
  evicted: GoldenManifest[];
  warnings: Array<{ vmName: string; inputsHash: string; message: string }>;
}

export async function runGc(
  store: SnapshotStore,
  backend: SandboxBackend,
  policy: GcPolicy,
): Promise<RunGcResult> {
  const warnings: RunGcResult['warnings'] = [];

  const forks = store.forks();
  const inspections = await Promise.all(
    forks.map((f) => backend.inspect(f.runVm).then((state) => ({ fork: f, state }))),
  );
  const liveGoldenHashes = new Set<string>();
  for (const { fork, state } of inspections) {
    if (state.state !== 'absent') {
      liveGoldenHashes.add(fork.goldenHash);
    } else {
      store.removeFork(fork.runVm);
    }
  }

  const toEvict = selectGoldensToEvict(store.list(), liveGoldenHashes, policy);
  for (const g of toEvict) {
    try {
      await backend.destroy(g.vmName);
    } catch (e) {
      warnings.push({
        vmName: g.vmName,
        inputsHash: g.inputsHash,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    store.remove(g.inputsHash);
  }
  return { evicted: toEvict, warnings };
}
