import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { runGc, type GcPolicy } from '../../sandbox/gc.js';
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

  const evicted = await runGc(store, backend, policy);

  if (evicted.length === 0) {
    return { ok: true, message: 'nothing to collect' };
  }
  const lines = evicted.map(g => `  - ${g.vmName} (${g.profileName}, hash ${g.inputsHash.slice(0, 12)})`);
  return { ok: true, message: `evicted ${evicted.length} golden${evicted.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
};
