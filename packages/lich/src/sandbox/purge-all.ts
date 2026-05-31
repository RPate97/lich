import { homedir } from "node:os";
import { join } from "node:path";
import { TartBackend } from "./tart.js";
import { SnapshotStore } from "./snapshot-store.js";
import { isLichManagedName } from "./naming.js";
import type { SandboxBackend } from "./backend.js";

export interface PurgeAllSandboxesOpts {
  backend?: SandboxBackend;
  store?: SnapshotStore;
  /** Substring match on VM name + inputs-hash prefix; absent → match everything. */
  hashFilter?: string;
  /** Destroy VMs but keep the manifest. */
  vmsOnly?: boolean;
  /** Wipe the manifest but leave VMs alone. */
  storeOnly?: boolean;
}

export interface PurgeAllSandboxesResult {
  removedVms: number;
  removedManifest: number;
}

async function purgeAllSandboxesImpl(
  opts: PurgeAllSandboxesOpts = {},
): Promise<PurgeAllSandboxesResult> {
  const backend = opts.backend ?? new TartBackend();
  const storeDir = process.env.LICH_HOME
    ? join(process.env.LICH_HOME, "sandboxes")
    : join(homedir(), ".lich", "sandboxes");
  const store = opts.store ?? new SnapshotStore(storeDir);

  let removedVms = 0;
  let removedManifest = 0;

  if (!opts.storeOnly) {
    const vms = await backend.list();
    for (const v of vms) {
      if (!isLichManagedName(v.name)) continue;
      if (opts.hashFilter && !v.name.includes(opts.hashFilter)) continue;
      await backend.destroy(v.name);
      removedVms++;
    }
  }

  if (!opts.vmsOnly) {
    if (opts.hashFilter) {
      for (const g of store.list()) {
        if (g.inputsHash.startsWith(opts.hashFilter) || g.vmName.includes(opts.hashFilter)) {
          store.remove(g.inputsHash);
          removedManifest++;
        }
      }
    } else {
      removedManifest = store.list().length;
      store.clear();
    }
  }

  return { removedVms, removedManifest };
}

export const _purgeAllSandboxesFn: {
  current: (opts?: PurgeAllSandboxesOpts) => Promise<PurgeAllSandboxesResult>;
} = {
  current: purgeAllSandboxesImpl,
};

export function purgeAllSandboxes(opts?: PurgeAllSandboxesOpts): Promise<PurgeAllSandboxesResult> {
  return _purgeAllSandboxesFn.current(opts);
}
