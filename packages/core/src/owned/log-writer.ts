import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export type LogStream = 'stdout' | 'stderr';
export type LogLevel = 'info' | 'error';

export interface LogLine {
  ts: string;
  service: string;
  stream: LogStream;
  level: LogLevel;
  message: string;
}

export interface ServiceLogWriterOptions {
  service: string;
  logDir: string;
}

export class ServiceLogWriter {
  private file: WriteStream | undefined;
  private readonly path: string;
  private readyPromise: Promise<void>;
  private buffers: Map<LogStream, string> = new Map([
    ['stdout', ''],
    ['stderr', ''],
  ]);
  private closed = false;

  constructor(private readonly opts: ServiceLogWriterOptions) {
    this.path = join(opts.logDir, `${opts.service}.jsonl`);
    this.readyPromise = this.ensureReady();
  }

  private async ensureReady(): Promise<void> {
    await mkdir(this.opts.logDir, { recursive: true });
    this.file = createWriteStream(this.path, { flags: 'a' });
  }

  async appendLine(stream: LogStream, level: LogLevel, message: string): Promise<void> {
    await this.readyPromise;
    // Silently drop writes after close() — this can happen when the detached
    // runner tears down streams before all buffered data events have fired.
    if (this.closed) return;
    const line: LogLine = {
      ts: new Date().toISOString(),
      service: this.opts.service,
      stream,
      level,
      message,
    };
    await new Promise<void>((resolve, reject) => {
      this.file!.write(JSON.stringify(line) + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async attachStdout(src: Readable): Promise<void> {
    await this.consume(src, 'stdout', 'info');
  }

  async attachStderr(src: Readable): Promise<void> {
    await this.consume(src, 'stderr', 'error');
  }

  private async consume(src: Readable, stream: LogStream, level: LogLevel): Promise<void> {
    await this.readyPromise;
    return new Promise<void>((resolve, reject) => {
      src.setEncoding('utf8');
      src.on('data', (chunk: string) => {
        const carryover = this.buffers.get(stream) ?? '';
        const combined = carryover + chunk;
        const parts = combined.split('\n');
        const tail = parts.pop() ?? '';
        this.buffers.set(stream, tail);
        for (const line of parts) {
          // File writes are queued by the underlying WriteStream; we don't await
          // here to avoid backpressure on the source stream.
          void this.appendLine(stream, level, line);
        }
      });
      src.once('end', () => resolve());
      src.once('error', (err) => reject(err));
    });
  }

  async close(): Promise<void> {
    await this.readyPromise;
    if (this.closed) return;
    this.closed = true;
    for (const [stream, buf] of this.buffers.entries()) {
      if (buf.length > 0) {
        const level: LogLevel = stream === 'stderr' ? 'error' : 'info';
        // Write partial buffer synchronously before the stream ends. We use the
        // same internal write path but bypass the `closed` guard we just set.
        const line: LogLine = {
          ts: new Date().toISOString(),
          service: this.opts.service,
          stream: stream as LogStream,
          level,
          message: buf,
        };
        await new Promise<void>((resolve, reject) => {
          this.file!.write(JSON.stringify(line) + '\n', (err) => (err ? reject(err) : resolve()));
        });
        this.buffers.set(stream, '');
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.file!.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
