import type { CommandHandler } from '../index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../sandbox/snapshot-store.js';
import { TartBackend } from '../../sandbox/tart.js';
import { SandboxRuntime } from '../../sandbox/runtime.js';
import { computeBakeInputsHash } from '../../sandbox/inputs-hash.js';
import { parseConfig } from '../../config/parse.js';
import { detectWorktree } from '../../worktree/detect.js';
import { pickDefaultProfile } from '../../profiles/default.js';

export const sandboxSnapshot: CommandHandler = async (ctx) => {
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

  const profileArg = typeof ctx.argv._[0] === 'string' ? ctx.argv._[0] : undefined;
  let profileName: string;
  if (profileArg) {
    profileName = profileArg;
  } else {
    const profiles = parsed.config.profiles;
    const hasProfilesSection = profiles !== undefined && Object.keys(profiles).length > 0;
    if (!hasProfilesSection) {
      profileName = 'default';
    } else {
      const pick = pickDefaultProfile(parsed.config);
      profileName = pick.name ?? 'default';
    }
  }

  const storeDir = sandbox.snapshot_store ?? (process.env.LICH_HOME
    ? join(process.env.LICH_HOME, 'sandboxes')
    : join(homedir(), '.lich', 'sandboxes'));
  const store = new SnapshotStore(storeDir);
  const backend = new TartBackend();
  const runtime = new SandboxRuntime(sandbox, { backend, snapshotStore: store });

  const hash = await computeBakeInputsHash({
    worktreePath: worktree.path,
    lichYamlPath,
    profileName,
    bakeInputs: sandbox.bake_inputs,
  });

  const existing = store.findByHash(hash);
  let reusedExisting = false;
  if (existing) {
    const state = await backend.inspect(existing.vmName);
    if (state.state !== 'absent') reusedExisting = true;
  }

  const goldenVm = await runtime.snapshot({
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    lichYamlPath,
    profileName,
  });

  const shortHash = hash.slice(0, 12);
  if (reusedExisting) {
    return { ok: true, message: `golden for hash ${shortHash} already exists (${goldenVm}); no rebake` };
  }
  return { ok: true, message: `created golden ${goldenVm} for hash ${shortHash}` };
};
