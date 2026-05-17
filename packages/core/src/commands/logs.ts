import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStackContext } from '../services/context';
import type { LogLine } from '../owned/log-writer';
import type { Registry } from '../registry';
import type { Command } from './types';

function parseSince(spec: string): number {
  const trimmed = spec.trim();
  const rel = trimmed.match(/^-(\d+)([smhd])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return ms;
  throw new Error(`invalid --since value: ${spec} (expected ISO timestamp or relative like -5m)`);
}

function getServiceFilter(flags: Record<string, string | boolean>): Set<string> | null {
  const raw = flags['service'];
  if (typeof raw !== 'string') return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function getLevelFilter(flags: Record<string, string | boolean>): 'info' | 'error' | null {
  const raw = flags['level'];
  if (raw === 'info' || raw === 'error') return raw;
  return null;
}

function getGrepFilter(flags: Record<string, string | boolean>): RegExp | null {
  const raw = flags['grep'];
  if (typeof raw !== 'string') return null;
  return new RegExp(raw);
}

function getTail(flags: Record<string, string | boolean>): number | null {
  const raw = flags['tail'];
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function makeLogsCommand(getRegistry: () => Registry): Command {
  return {
    name: 'logs',
    describe: 'Query per-service log files for the current stack',
    async run(ctx) {
      const stackCtx = await resolveStackContext(ctx.cwd);
      const entry = await getRegistry().get(stackCtx.worktreeKey);
      if (!entry) {
        return { lines: [], note: 'no stack running for this worktree (run `levelzero dev`)' };
      }
      const logDir = join(stackCtx.worktreePath, entry.logDir);
      let files: string[];
      try {
        files = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return { lines: [], note: `log dir does not exist yet: ${logDir}` };
      }

      const serviceFilter = getServiceFilter(ctx.flags);
      if (serviceFilter) files = files.filter((f) => serviceFilter.has(f.replace(/\.jsonl$/, '')));

      const sinceMs = (() => {
        const raw = ctx.flags['since'];
        return typeof raw === 'string' ? parseSince(raw) : null;
      })();
      const levelFilter = getLevelFilter(ctx.flags);
      const grepFilter = getGrepFilter(ctx.flags);
      const tail = getTail(ctx.flags);

      const all: LogLine[] = [];
      for (const f of files) {
        const raw = await readFile(join(logDir, f), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let rec: LogLine;
          try { rec = JSON.parse(line) as LogLine; } catch { continue; }
          if (sinceMs !== null && Date.parse(rec.ts) < sinceMs) continue;
          if (levelFilter && rec.level !== levelFilter) continue;
          if (grepFilter && !grepFilter.test(rec.message)) continue;
          all.push(rec);
        }
      }
      all.sort((a, b) => a.ts.localeCompare(b.ts));
      const result = tail !== null ? all.slice(-tail) : all;
      return { lines: result };
    },
  };
}
