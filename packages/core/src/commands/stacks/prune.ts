import { access } from 'node:fs/promises';
import type { Registry } from '../../registry';
import type { Command } from '../types';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function makeStacksPruneCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.prune',
    describe: 'Remove registry entries for worktrees that no longer exist on disk',
    async run(ctx) {
      const reg = getRegistry();
      const entries = await reg.list();
      const pruned: string[] = [];
      for (const { key, entry } of entries) {
        if (!(await pathExists(entry.path))) {
          await reg.remove(key);
          pruned.push(key);
        }
      }
      if (ctx.format === 'json') return { pruned };
      if (pruned.length === 0) return 'no stale stacks to prune\n';
      const lines: string[] = [`pruned ${pruned.length} stale stack(s):`];
      for (const key of pruned) lines.push(`  ${key}`);
      return lines.join('\n') + '\n';
    },
  };
}
