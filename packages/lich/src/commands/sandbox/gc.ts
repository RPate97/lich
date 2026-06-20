import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { runGc, type GcPolicy } from '../../sandbox/gc.js';
import { gcOrphanedSshConfigBlocks } from '../../sandbox/mutagen.js';
import { parseConfig } from '../../config/parse.js';
import { detectWorktree } from '../../worktree/detect.js';

const DEFAULT_POLICY: GcPolicy = { keepPerProfile: 2, maxTotalBytes: 20 * 1e9 };

export const sandboxGc: CommandHandler = async () => {
  const cwd = process.cwd();
  let worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (e) {
    return { ok: false, message: `not in a worktree: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 };
  }
  const lichYamlPath = join(worktree.path, 'lich.yaml');
  const parsed = await parseConfig(lichYamlPath);
  if (!parsed.ok) {
    return { ok: false, message: `failed to parse lich.yaml: ${parsed.errors.join('; ')}`, exitCode: 1 };
  }
  const sandbox = parsed.config.runtime?.sandbox;
  if (!sandbox) {
    return { ok: false, message: 'runtime.sandbox is not configured in lich.yaml', exitCode: 1 };
  }

  const storeDir = sandbox.snapshot_store ?? (process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes'));
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();

  const policy: GcPolicy = {
    keepPerProfile: sandbox.gc?.keep_per_profile ?? DEFAULT_POLICY.keepPerProfile,
    maxTotalBytes: sandbox.gc?.max_total_gb !== undefined
      ? sandbox.gc.max_total_gb * 1e9
      : DEFAULT_POLICY.maxTotalBytes,
  };

  const { evicted, warnings } = await runGc(store, backend, policy);

  let sshRemoved: string[] = [];
  try {
    const vms = await backend.list();
    const result = gcOrphanedSshConfigBlocks(join(homedir(), '.ssh', 'config'), vms.map(v => v.name));
    sshRemoved = result.removed;
  } catch { /* best-effort */ }

  const warningLines = warnings.map(w => `⚠ destroy failed for ${w.vmName}: ${w.message}`);
  const sshLine = sshRemoved.length > 0
    ? `cleaned ${sshRemoved.length} orphaned ssh config block${sshRemoved.length === 1 ? '' : 's'}: ${sshRemoved.join(', ')}`
    : null;
  const sshSuffix = sshLine ? `\n${sshLine}` : '';

  if (evicted.length === 0) {
    const base = 'nothing to collect';
    return { ok: true, message: (warningLines.length ? `${base}\n${warningLines.join('\n')}` : base) + sshSuffix };
  }
  const lines = evicted.map(g => `  - ${g.vmName} (${g.profileName}, hash ${g.inputsHash.slice(0, 12)})`);
  const header = `evicted ${evicted.length} golden${evicted.length === 1 ? '' : 's'}:`;
  const message = (warningLines.length
    ? `${header}\n${lines.join('\n')}\n${warningLines.join('\n')}`
    : `${header}\n${lines.join('\n')}`) + sshSuffix;
  return { ok: true, message };
};
