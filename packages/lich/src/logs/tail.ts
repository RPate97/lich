import { open, stat } from "node:fs/promises";

const DEFAULT_INTERVAL_MS = 100;
// Bound retrospective buffer memory; drop oldest half when exceeded.
const BUFFER_MAX_BYTES = 1024 * 1024;

export interface LogTailOptions {
  logPath: string;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Skip bytes already in the file from a prior run. Defaults to 0 (read from start). */
  startOffset?: number;
}

export type LogLineCallback = (line: string) => void;
export type Unsubscribe = () => void;

/**
 * Tails one log file and fans out new lines to N subscribers.
 *
 * Lines emitted before `onLine()` is registered are NOT replayed; use the
 * `buffer` getter for retrospective access. `start()` / `stop()` are idempotent.
 */
export class LogTail {
  private readonly logPath: string;
  private readonly intervalMs: number;
  private readonly signal: AbortSignal | undefined;
  private abortListener: (() => void) | null = null;
  private readonly subscribers: Set<LogLineCallback> = new Set();
  private started = false;
  private stopped = false;
  private offset: number;
  private pending = "";
  private bufferContent = "";
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(opts: LogTailOptions) {
    this.logPath = opts.logPath;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.signal = opts.signal;
    this.offset = opts.startOffset ?? 0;

    if (this.signal !== undefined) {
      if (this.signal.aborted) {
        this.stopped = true;
      } else {
        this.abortListener = () => {
          void this.stop();
        };
        this.signal.addEventListener("abort", this.abortListener, {
          once: true,
        });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.started) return;
    this.started = true;

    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.signal !== undefined && this.abortListener !== null) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = null;
    }
  }

  /** Subscribe to new lines. Returned unsubscribe is idempotent. */
  onLine(cb: LogLineCallback): Unsubscribe {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** All bytes read since `start()`, capped at BUFFER_MAX_BYTES (oldest half dropped on overflow). */
  get buffer(): string {
    return this.bufferContent;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    // setInterval can fire while previous tick is still awaiting I/O.
    if (this.polling) return;
    this.polling = true;

    try {
      let size: number | null = null;
      try {
        const st = await stat(this.logPath);
        size = st.size;
      } catch {
        // ENOENT before supervisor starts writing is expected.
      }

      if (this.stopped) return;

      if (size === null) return;

      if (size > this.offset) {
        await this.readNewBytes(size);
      }
      // size < offset (truncation) intentionally ignored — re-reading would
      // deliver lines twice.
    } finally {
      this.polling = false;
    }
  }

  private async readNewBytes(size: number): Promise<void> {
    const length = size - this.offset;
    const buf = Buffer.allocUnsafe(length);

    let handle;
    try {
      handle = await open(this.logPath, "r");
    } catch {
      return;
    }

    let bytesRead = 0;
    try {
      const r = await handle.read(buf, 0, length, this.offset);
      bytesRead = r.bytesRead;
    } catch {
      return;
    } finally {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }

    if (bytesRead <= 0) return;
    this.offset += bytesRead;

    if (this.stopped) return;

    const chunk = buf.slice(0, bytesRead).toString("utf8");

    this.appendToBuffer(chunk);

    this.pending += chunk;

    const lastNewline = this.pending.lastIndexOf("\n");
    if (lastNewline < 0) {
      return;
    }

    const complete = this.pending.slice(0, lastNewline);
    this.pending = this.pending.slice(lastNewline + 1);

    const lines = complete.split(/\r?\n/);
    for (const line of lines) {
      if (this.stopped) return;
      this.emitLine(line);
    }
  }

  private emitLine(line: string): void {
    // Snapshot so a subscriber that unsubscribes during emission doesn't
    // perturb iteration.
    const snapshot = Array.from(this.subscribers);
    for (const cb of snapshot) {
      try {
        cb(line);
      } catch {
        /* subscriber threw; ignore */
      }
    }
  }

  private appendToBuffer(chunk: string): void {
    this.bufferContent += chunk;
    if (this.bufferContent.length > BUFFER_MAX_BYTES) {
      this.bufferContent = this.bufferContent.slice(
        Math.floor(this.bufferContent.length / 2),
      );
    }
  }
}
