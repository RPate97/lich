import type { CommandHandler } from '../index.js';
import { purgeAllSandboxes } from '../../sandbox/purge-all.js';

// `lich sandbox purge` — by default destroys all lich-managed VMs + goldens.
// `--hash <prefix>` — destroys only the matching golden + its forks.
// `--vms-only` — destroys VMs but keeps the manifest entries.
// `--store-only` — wipes the manifest but leaves VMs alone.
export const sandboxPurge: CommandHandler = async (ctx) => {
  const result = await purgeAllSandboxes({
    hashFilter: ctx.argv.hash ? String(ctx.argv.hash) : undefined,
    vmsOnly: Boolean(ctx.argv['vms-only']),
    storeOnly: Boolean(ctx.argv['store-only']),
  });
  return {
    ok: true,
    message: `purged ${result.removedVms} VMs and ${result.removedManifest} manifest entries`,
  };
};
