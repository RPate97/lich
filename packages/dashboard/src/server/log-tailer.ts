import { open, stat } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEvent } from '../types';

const MAX_BACKLOG_LINES = 500;
const POLL_INTERVAL_MS = 300;

/**
 * Resolve the log file to tail for a service.
 *
 * LEV-245: detached `dev` (the default) now writes structured JSONL to
 * `<state>/<key>/logs/<service>.jsonl` via `ServiceLogWriter`. The `--live`
 * runner writes `<logDir>/<service>.jsonl` (typically `.lich/logs/`).
 * We check the detached JSONL path first, then the live JSONL path. The old
 * raw `.log` path is kept as a final fallback for stacks started before
 * LEV-245 rolled out.
 *
 * Returns `undefined` if no file exists yet.
 */
export async function resolveLogFile(
  worktreePath: string,
  worktreeKey: string,
  service: string,
): Promise<string | undefined> {
  // LEV-245: detached runner now writes JSONL here.
  const detachedJsonl = join(
    worktreePath, '.lich', 'state', worktreeKey, 'logs', `${service}.jsonl`,
  );
  // `--live` runner writes JSONL here.
  const liveJsonl = join(worktreePath, '.lich', 'logs', `${service}.jsonl`);
  // Legacy raw log from pre-LEV-245 detached runs.
  const legacyRawLog = join(
    worktreePath, '.lich', 'state', worktreeKey, 'logs', `${service}.log`,
  );
  for (const candidate of [detachedJsonl, liveJsonl, legacyRawLog]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Parse one log line — JSON record if it parses, plain text otherwise. */
function parseLine(line: string): LogEvent {
  if (line.startsWith('{')) {
    try {
      const rec = JSON.parse(line) as {
        ts?: string; level?: 'info' | 'error';
        stream?: 'stdout' | 'stderr'; message?: string;
      };
      if (typeof rec.message === 'string') {
        return { line: rec.message, ts: rec.ts, level: rec.level, stream: rec.stream };
      }
    } catch {
      /* not JSON — fall through */
    }
  }
  return { line };
}

/**
 * Tails a single file by byte offset. On `start()` it emits the last
 * `MAX_BACKLOG_LINES` of existing content, then polls for growth every
 * `POLL_INTERVAL_MS`, emitting one event per newly appended line. A shrink
 * (offset > size) resets the offset to 0 and resyncs. `stop()` clears the
 * timer — call it when the SSE client disconnects.
 */
export class LogTailer {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private carry = '';

  constructor(
    private readonly file: string,
    private readonly onEvent: (e: LogEvent) => void,
  ) {}

  async start(): Promise<void> {
    await this.readFrom(0, true);
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return; // file vanished — keep the offset, wait for it to come back
    }
    if (size < this.offset) {
      this.offset = 0;
      this.carry = '';
    }
    if (size > this.offset) {
      await this.readFrom(this.offset, false);
    }
  }

  /**
   * Read from `start` to EOF, emit complete lines, advance the offset.
   * When `backlog` is true, only the last MAX_BACKLOG_LINES are emitted.
   */
  private async readFrom(start: number, backlog: boolean): Promise<void> {
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch {
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size <= start) return;
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      this.offset = size;
      const text = this.carry + buf.toString('utf8');
      const parts = text.split('\n');
      this.carry = parts.pop() ?? '';
      const lines = backlog ? parts.slice(-MAX_BACKLOG_LINES) : parts;
      for (const line of lines) {
        if (line.length === 0) continue;
        this.onEvent(parseLine(line));
      }
    } finally {
      await handle.close();
    }
  }
}
