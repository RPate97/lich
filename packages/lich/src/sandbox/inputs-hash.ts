import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// V0: hash the lich.yaml content + the profile name. If either changes,
// the snapshot is considered stale and a re-bake is required.
//
// Future (V1): also hash lockfile, migrations dir contents, seed files.

export function computeInputsHash(lichYamlPath: string, profileName: string): string {
  const content = readFileSync(lichYamlPath, 'utf8');
  const h = createHash('sha256');
  h.update('lich.yaml:');
  h.update(content);
  h.update('\nprofile:');
  h.update(profileName);
  return h.digest('hex');
}

export function computeInputsHashFromString(lichYamlContent: string, profileName: string): string {
  const h = createHash('sha256');
  h.update('lich.yaml:');
  h.update(lichYamlContent);
  h.update('\nprofile:');
  h.update(profileName);
  return h.digest('hex');
}
