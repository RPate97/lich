import type { Registry } from '../../registry';
import type { Command } from '../types';

export function makeStacksListCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.list',
    describe: 'List every running levelzero stack on this machine',
    async run() {
      const entries = await getRegistry().list();
      return {
        stacks: entries.map(({ key, entry }) => ({
          key,
          path: entry.path,
          branch: entry.branch,
          ports: entry.ports,
          urls: entry.urls,
          createdAt: entry.createdAt,
        })),
      };
    },
  };
}
