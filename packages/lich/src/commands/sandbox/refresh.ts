import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { computeInputsHash } from '../../sandbox/inputs-hash.js';
import { goldenName } from '../../sandbox/naming.js';

// Forces the golden for the current lich.yaml + profile to be deleted,
// so the next `lich up` will cold-boot and re-bake. Used when the
// inputs-hash hasn't changed but the user wants a fresh bake (e.g. they
// pulled new code that doesn't change lich.yaml but does change seed data).
export const sandboxRefresh: CommandHandler = async (ctx) => {
  const profile = String(ctx.argv._[0] ?? 'default');
  const lichYamlPath = join(process.cwd(), 'lich.yaml');
  const storeDir = process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes');
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();

  const hash = computeInputsHash(lichYamlPath, profile);
  const vm = goldenName(hash);

  const removed = store.remove(hash);
  await backend.destroy(vm);

  return {
    ok: true,
    message: removed
      ? `removed golden for profile '${profile}' (hash ${hash.slice(0, 12)}). Next 'lich up ${profile}' will cold-boot.`
      : `no golden existed for profile '${profile}'. (Looking for hash ${hash.slice(0, 12)})`,
  };
};
