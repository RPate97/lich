import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashGlobs } from './glob-hash.js';

// Hash lich.yaml content + profile name. If either changes, the snapshot is
// stale and a rebake is required. computeBakeInputsHash extends this with the
// content of declared bake_inputs globs.

export function computeInputsHash(lichYamlPath: string, profileName: string): string {
  return computeInputsHashFromString(readFileSync(lichYamlPath, 'utf8'), profileName);
}

export function computeInputsHashFromString(lichYamlContent: string, profileName: string): string {
  const h = createHash('sha256');
  h.update('lich.yaml:');
  h.update(lichYamlContent);
  h.update('\nprofile:');
  h.update(profileName);
  return h.digest('hex');
}

// The content-addressed key for a golden: lich.yaml + profile + the content of
// all declared bake_inputs. Two worktrees with identical migrations/seed/lockfile
// and the same lich.yaml+profile produce the same hash and share a golden; any
// divergence in a declared input produces a different hash.
export async function computeBakeInputsHash(opts: {
  worktreePath: string;
  lichYamlPath: string;
  profileName: string;
  bakeInputs: ReadonlyArray<string>;
}): Promise<string> {
  const base = computeInputsHash(opts.lichYamlPath, opts.profileName);
  const globs = await hashGlobs(opts.worktreePath, opts.bakeInputs);
  const h = createHash('sha256');
  h.update('base:');
  h.update(base);
  h.update('\nbake_inputs:');
  h.update(globs);
  return h.digest('hex');
}
