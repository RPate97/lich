import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { isLichManagedName } from '../../sandbox/naming.js';

export const sandboxStatus: CommandHandler = async (ctx) => {
  const storeDir = process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes');
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();

  const goldens = store.list();
  const vms = await backend.list();
  const lichVms = vms.filter(v => isLichManagedName(v.name));

  if (ctx.argv.json) {
    process.stdout.write(JSON.stringify({ goldens, vms: lichVms }, null, 2) + '\n');
    return { ok: true };
  }

  process.stdout.write('Goldens (snapshot cache):\n');
  if (goldens.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const g of goldens) {
      process.stdout.write(`  ${g.vmName}  profile=${g.profileName}  hash=${g.inputsHash.slice(0, 12)}  created=${g.createdAt}\n`);
    }
  }

  process.stdout.write('\nLich-managed VMs:\n');
  if (lichVms.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const v of lichVms) {
      process.stdout.write(`  ${v.name}  state=${v.state}\n`);
    }
  }
  return { ok: true };
};
