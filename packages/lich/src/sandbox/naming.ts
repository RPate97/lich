// Deterministic naming for sandbox VMs.
//   - Goldens (snapshot caches) named: lich-golden-<inputs-hash-prefix>
//   - Run VMs (active stacks)  named: lich-run-<worktree-id>-<profile-slug>

export function goldenName(inputsHash: string): string {
  // Tart requires names matching /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/.
  // First 12 hex chars of the hash is unique enough for V0.
  return `lich-golden-${inputsHash.slice(0, 12)}`;
}

export function runName(worktreeId: string, profileName: string): string {
  const slug = profileName.replace(/[^A-Za-z0-9_-]/g, '-');
  // worktreeId is already an opaque short identifier from lich's worktree
  // discovery. Truncate defensively.
  const wid = worktreeId.slice(0, 16);
  return `lich-run-${wid}-${slug}`;
}

export function isLichManagedName(name: string): boolean {
  return name.startsWith('lich-golden-') || name.startsWith('lich-run-');
}
