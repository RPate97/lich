import type { StackSnapshot } from '../state/snapshot.js';
import type { Worktree } from '../worktree/detect.js';
import type { RuntimeContext } from './runtime.js';

export function isSandboxStack(snapshot: StackSnapshot | null | undefined): boolean {
  return snapshot != null && snapshot.sandbox === true;
}

export function sandboxCtxFromSnapshot(
  worktree: Worktree,
  snapshot: StackSnapshot,
  lichYamlPath: string,
): RuntimeContext {
  return {
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    lichYamlPath,
    profileName: snapshot.active_profile ?? 'default',
  };
}
