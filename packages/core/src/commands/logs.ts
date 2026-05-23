import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStackContext } from '../services/context';
import type { LogLine } from '../owned/log-writer';
import type { Registry } from '../registry';
import type { Command } from './types';

/**
 * Fallback parser for legacy raw `.log` files written by the detached runner
 * before LEV-245. The file has no per-line timestamps — only the chunks the
 * child wrote — so we synthesize a `LogLine` per non-empty line with an empty
 * `ts`. Empty timestamps sort before any real ISO timestamp, so they appear
 * before JSONL entries in the merged output.
 */
function parseRawLogFile(service: string, raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    out.push({
      ts: '',
      service,
      stream: 'stdout',
      level: 'info',
      message: line,
    });
  }
  return out;
}

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
        const note = 'no stack running for this worktree (run `lich dev`)';
        if (ctx.format === 'json') return { lines: [], note };
        return note + '\n';
      }

      const serviceFilter = getServiceFilter(ctx.flags);
      const sinceMs = (() => {
        const raw = ctx.flags['since'];
        return typeof raw === 'string' ? parseSince(raw) : null;
      })();
      const levelFilter = getLevelFilter(ctx.flags);
      const grepFilter = getGrepFilter(ctx.flags);
      const tail = getTail(ctx.flags);

      // LEV-194 / LEV-245 — log source dirs:
      //
      // 1. `.lich/state/<key>/logs` (detached runner, LEV-245+): JSONL
      //    files written by `ServiceLogWriter` — one record per line with
      //    `{ts, service, stream, level, message}`.
      // 2. `entry.logDir` (`.lich/logs`, `--live` runner): JSONL files
      //    written by `ServiceLogWriter` in the foreground runner.
      // 3. `.lich/state/<key>/logs` (legacy, pre-LEV-245): raw `.log`
      //    files — chunks appended directly via an FD. Still present for
      //    stacks started before LEV-245.
      //
      // We read all three and merge, deduplicating by combining them.
      const stateLogDir = join(
        stackCtx.worktreePath,
        '.lich',
        'state',
        stackCtx.worktreeKey,
        'logs',
      );
      const liveLogDir = join(stackCtx.worktreePath, entry.logDir);

      const all: LogLine[] = [];
      let foundAny = false;

      // Helper: read a directory of JSONL files and push matching records.
      const readJsonlDir = async (dir: string) => {
        try {
          let files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
          if (serviceFilter) {
            files = files.filter((f) => serviceFilter.has(f.replace(/\.jsonl$/, '')));
          }
          foundAny = foundAny || files.length > 0;
          for (const f of files) {
            const raw = await readFile(join(dir, f), 'utf8');
            for (const line of raw.split('\n')) {
              if (!line) continue;
              let rec: LogLine;
              try {
                rec = JSON.parse(line) as LogLine;
              } catch {
                continue;
              }
              if (sinceMs !== null && Date.parse(rec.ts) < sinceMs) continue;
              if (levelFilter && rec.level !== levelFilter) continue;
              if (grepFilter && !grepFilter.test(rec.message)) continue;
              all.push(rec);
            }
          }
        } catch {
          // Dir absent — fine.
        }
      };

      // 1. Detached-mode JSONL (LEV-245+) — state dir.
      await readJsonlDir(stateLogDir);
      // 2. Live-mode JSONL — live log dir (skip if same as state dir).
      if (liveLogDir !== stateLogDir) {
        await readJsonlDir(liveLogDir);
      }

      // 3. Legacy raw `.log` fallback (pre-LEV-245 detached runs).
      try {
        let files = (await readdir(stateLogDir)).filter((f) => f.endsWith('.log'));
        if (serviceFilter) {
          files = files.filter((f) => serviceFilter.has(f.replace(/\.log$/, '')));
        }
        foundAny = foundAny || files.length > 0;
        for (const f of files) {
          const service = f.replace(/\.log$/, '');
          const raw = await readFile(join(stateLogDir, f), 'utf8');
          for (const rec of parseRawLogFile(service, raw)) {
            // Raw log lines have no embedded ts/level: `--since` and
            // `--level` filters can't match them, so skip when those filters
            // are active (the user explicitly asked to filter by metadata
            // raw logs don't carry).
            if (sinceMs !== null) continue;
            if (levelFilter && levelFilter !== 'info') continue;
            if (grepFilter && !grepFilter.test(rec.message)) continue;
            all.push(rec);
          }
        }
      } catch {
        // Dir absent — fine.
      }

      if (!foundAny) {
        const note = `log dir does not exist yet: ${stateLogDir}`;
        if (ctx.format === 'json') return { lines: [], note };
        return note + '\n';
      }

      all.sort((a, b) => a.ts.localeCompare(b.ts));
      const result = tail !== null ? all.slice(-tail) : all;
      if (ctx.format === 'json') return { lines: result };
      if (result.length === 0) return 'no log lines matched\n';
      const out: string[] = [];
      for (const r of result) {
        const lvl = r.level.toUpperCase();
        out.push(`${r.ts} [${lvl}] ${r.service} ${r.message}`);
      }
      return out.join('\n') + '\n';
    },
  };
}
