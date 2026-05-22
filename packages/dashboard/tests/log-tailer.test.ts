// packages/dashboard/tests/log-tailer.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogTailer } from '../src/server/log-tailer';
import type { LogEvent } from '../src/types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LogTailer', () => {
  it('emits an initial backlog of the existing lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'log-'));
    const file = join(dir, 'api.log');
    await writeFile(file, 'line one\nline two\n');
    const events: LogEvent[] = [];
    const tailer = new LogTailer(file, (e) => events.push(e));
    await tailer.start();
    await tailer.stop();
    expect(events.map((e) => e.line)).toEqual(['line one', 'line two']);
    await rm(dir, { recursive: true, force: true });
  });

  it('emits new lines appended after start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'log-'));
    const file = join(dir, 'api.log');
    await writeFile(file, 'first\n');
    const events: LogEvent[] = [];
    const tailer = new LogTailer(file, (e) => events.push(e));
    await tailer.start();
    await appendFile(file, 'second\nthird\n');
    await wait(400);
    await tailer.stop();
    expect(events.map((e) => e.line)).toEqual(['first', 'second', 'third']);
    await rm(dir, { recursive: true, force: true });
  });

  it('resyncs from offset 0 when the file is truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'log-'));
    const file = join(dir, 'api.log');
    await writeFile(file, 'old line one\nold line two\n');
    const events: LogEvent[] = [];
    const tailer = new LogTailer(file, (e) => events.push(e));
    await tailer.start();
    await writeFile(file, 'fresh\n'); // truncates + rewrites
    await wait(400);
    await tailer.stop();
    expect(events.map((e) => e.line)).toContain('fresh');
    await rm(dir, { recursive: true, force: true });
  });

  it('parses JSONL lines into structured events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'log-'));
    const file = join(dir, 'api.jsonl');
    await writeFile(
      file,
      JSON.stringify({ ts: '2026-05-21T00:00:00Z', level: 'error', stream: 'stderr', message: 'boom' }) + '\n',
    );
    const events: LogEvent[] = [];
    const tailer = new LogTailer(file, (e) => events.push(e));
    await tailer.start();
    await tailer.stop();
    expect(events[0]).toEqual({
      line: 'boom',
      ts: '2026-05-21T00:00:00Z',
      level: 'error',
      stream: 'stderr',
    });
    await rm(dir, { recursive: true, force: true });
  });
});
