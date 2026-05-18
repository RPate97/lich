import type { Registry } from '../../registry';
import type { Command } from '../types';

interface StackListRow {
  key: string;
  path: string;
  branch: string;
  ports: Record<string, number>;
  urls: Record<string, string>;
  createdAt: string;
}

export function makeStacksListCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.list',
    describe: 'List every running levelzero stack on this machine',
    async run(ctx) {
      const entries = await getRegistry().list();
      const stacks: StackListRow[] = entries.map(({ key, entry }) => ({
        key,
        path: entry.path,
        branch: entry.branch,
        ports: entry.ports,
        urls: entry.urls,
        createdAt: entry.createdAt,
      }));
      if (ctx.format === 'json') return { stacks };
      return renderStacksListPretty(stacks);
    },
  };
}

/**
 * Three-column `KEY  PATH  PORTS` table. Ports are serialized as
 * `name=value` pairs joined by commas so the column stays single-line; the
 * full URL list is omitted from the pretty form (callers who need it should
 * use `levelzero urls` or `--json`).
 */
export function renderStacksListPretty(stacks: StackListRow[]): string {
  if (stacks.length === 0) return 'no stacks running\n';
  const rows = stacks.map((s) => {
    const portStr = Object.entries(s.ports)
      .map(([name, port]) => `${name}=${port}`)
      .join(',');
    return { key: s.key, path: s.path, ports: portStr || '-' };
  });
  const headers = { key: 'KEY', path: 'PATH', ports: 'PORTS' };
  const widthKey = Math.max(headers.key.length, ...rows.map((r) => r.key.length));
  const widthPath = Math.max(headers.path.length, ...rows.map((r) => r.path.length));
  const lines: string[] = [];
  lines.push(
    `${headers.key.padEnd(widthKey)}  ${headers.path.padEnd(widthPath)}  ${headers.ports}`,
  );
  for (const r of rows) {
    lines.push(`${r.key.padEnd(widthKey)}  ${r.path.padEnd(widthPath)}  ${r.ports}`);
  }
  return lines.join('\n') + '\n';
}
