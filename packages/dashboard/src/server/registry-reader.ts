import { readFile } from 'node:fs/promises';

/**
 * One stack's registry entry — mirrors the shape `@levelzero/core` writes to
 * `~/.levelzero/registry.json`. Defined locally (rather than imported from
 * `@levelzero/core/registry`) so the dashboard package carries no build-order
 * dependency on core: the dashboard only ever *reads* this JSON file.
 */
export interface StackEntry {
  path: string;
  branch: string;
  ports: Record<string, number>;
  urls: Record<string, string>;
  containers: string[];
  network: string;
  logDir: string;
  createdAt: string;
  composeFile?: string;
  /** Agent that started this stack; absent / undefined = manual (LEV-241). */
  startedBy?: string;
}

export interface RegistryData {
  stacks: Record<string, StackEntry>;
}

/**
 * Read and parse the global lich registry JSON. Read-only: the dashboard never
 * writes the registry, so no advisory lock is taken.
 *
 * Tolerant by design — a missing file (no stacks ever started) or a malformed
 * file (mid-write race, hand-edit) both yield `{ stacks: {} }` rather than
 * throwing, so the dashboard renders an empty state instead of crashing.
 *
 * `urls` is defaulted to `{}` for legacy entries written before the field
 * existed — same default the core `Registry` class applies on its read path.
 */
export async function readRegistry(path: string): Promise<RegistryData> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { stacks: {} };
  }
  let parsed: RegistryData;
  try {
    parsed = JSON.parse(raw) as RegistryData;
  } catch {
    return { stacks: {} };
  }
  if (!parsed.stacks || typeof parsed.stacks !== 'object') {
    return { stacks: {} };
  }
  for (const key of Object.keys(parsed.stacks)) {
    const entry = parsed.stacks[key]!;
    if (!entry.urls || typeof entry.urls !== 'object') {
      entry.urls = {};
    }
  }
  return parsed;
}
