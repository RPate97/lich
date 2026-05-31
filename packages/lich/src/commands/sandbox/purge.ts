import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { isLichManagedName } from '../../sandbox/naming.js';

// `lich sandbox purge` — by default destroys all lich-managed VMs + goldens.
// `--hash <prefix>` — destroys only the matching golden + its forks.
// `--vms-only` — destroys VMs but keeps the manifest entries.
// `--store-only` — wipes the manifest but leaves VMs alone.
export const sandboxPurge: CommandHandler = async (ctx) => {
  const storeDir = process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes');
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();

  const hashFilter = ctx.argv.hash ? String(ctx.argv.hash) : undefined;
  const vmsOnly = Boolean(ctx.argv['vms-only']);
  const storeOnly = Boolean(ctx.argv['store-only']);

  let removedVms = 0;
  let removedManifest = 0;

  if (!storeOnly) {
    const vms = await backend.list();
    for (const v of vms) {
      if (!isLichManagedName(v.name)) continue;
      if (hashFilter && !v.name.includes(hashFilter)) continue;
      await backend.destroy(v.name);
      removedVms++;
    }
  }

  if (!vmsOnly) {
    if (hashFilter) {
      for (const g of store.list()) {
        if (g.inputsHash.startsWith(hashFilter) || g.vmName.includes(hashFilter)) {
          store.remove(g.inputsHash);
          removedManifest++;
        }
      }
    } else {
      removedManifest = store.list().length;
      store.clear();
    }
  }

  return { ok: true, message: `purged ${removedVms} VMs and ${removedManifest} manifest entries` };
};
