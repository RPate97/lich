import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Worktree {
  path: string;
  configPath: string;
  key: string;
}

const CONFIG_FILENAME = 'lich.config.ts';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findWorktree(startDir: string): Promise<Worktree | null> {
  let current = await realpath(startDir);
  while (true) {
    const candidate = join(current, CONFIG_FILENAME);
    if (await exists(candidate)) {
      const root = await realpath(current);
      return {
        path: root,
        configPath: candidate,
        key: computeWorktreeKey(root),
      };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function computeWorktreeKey(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}
