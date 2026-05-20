import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStackContext } from '../services/context';
import type { LogLine } from '../owned/log-writer';
import type { Registry } from '../registry';
import type { Command } from './types';

/**
 * Detached owned services (LEV-194 default `dev` mode) dump raw stdout/stderr
 * to a single `<service>.log` file under the state dir. The file has no per-
 * line timestamps — only the chunks the child wrote — so we synthesize a
 * `LogLine` per non-empty line with an empty `ts`. Empty timestamps sort
 * before any real ISO timestamp, so JSONL entries (which DO carry `ts`)
 * appear after the raw `.log` lines in the merged output. That matches the
 * common case where the JSONL stream is from the `--live` runner of a
 * previous session and the `.log` stream is the current detached session.
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
        const note = 'no stack running for this worktree (run `levelzero dev`)';
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

      // LEV-194 — two possible source dirs:
      //
      // 1. `entry.logDir` (`.levelzero/logs`): JSONL files written by the
      //    `--live` foreground runner via `ServiceLogWriter`.
      // 2. `.levelzero/state/<key>/logs`: raw `.log` files written by the
      //    default detached runner (each child's stdout/stderr appended
      //    directly via an `fs.open` FD passed to `spawn`).
      //
      // We read whichever exists. The detached path is the new default, so
      // most stacks will only have raw `.log` files going forward.
      const jsonlDir = join(stackCtx.worktreePath, entry.logDir);
      const rawDir = join(
        stackCtx.worktreePath,
        '.levelzero',
        'state',
        stackCtx.worktreeKey,
        'logs',
      );

      const all: LogLine[] = [];
      let foundAny = false;

      try {
        let files = (await readdir(jsonlDir)).filter((f) => f.endsWith('.jsonl'));
        if (serviceFilter) {
          files = files.filter((f) => serviceFilter.has(f.replace(/\.jsonl$/, '')));
        }
        foundAny = foundAny || files.length > 0;
        for (const f of files) {
          const raw = await readFile(join(jsonlDir, f), 'utf8');
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
        // Dir absent — fine, the detached path uses a different one.
      }

      try {
        let files = (await readdir(rawDir)).filter((f) => f.endsWith('.log'));
        if (serviceFilter) {
          files = files.filter((f) => serviceFilter.has(f.replace(/\.log$/, '')));
        }
        foundAny = foundAny || files.length > 0;
        for (const f of files) {
          const service = f.replace(/\.log$/, '');
          const raw = await readFile(join(rawDir, f), 'utf8');
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
        const note = `log dir does not exist yet: ${jsonlDir}`;
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
