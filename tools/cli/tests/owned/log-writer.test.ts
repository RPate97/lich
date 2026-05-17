import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ServiceLogWriter, type LogLine } from '../../src/owned/log-writer';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lz-log-')));
});

function readLines(path: string): LogLine[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('ServiceLogWriter', () => {
  it('writes nothing when no data is piped', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    await w.close();
    expect(existsSync(join(tmp, 'api.jsonl'))).toBe(true);
    expect(readFileSync(join(tmp, 'api.jsonl'), 'utf8')).toBe('');
  });

  it('writes one JSON line per stdout line, level=info', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    const src = Readable.from(['hello\n', 'world\n']);
    await w.attachStdout(src);
    await w.close();
    const lines = readLines(join(tmp, 'api.jsonl'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ service: 'api', stream: 'stdout', level: 'info', message: 'hello' });
    expect(lines[1]).toMatchObject({ service: 'api', stream: 'stdout', level: 'info', message: 'world' });
    expect(typeof lines[0]!.ts).toBe('string');
  });

  it('writes stderr with level=error', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    await w.attachStderr(Readable.from(['boom\n']));
    await w.close();
    const lines = readLines(join(tmp, 'api.jsonl'));
    expect(lines[0]).toMatchObject({ service: 'api', stream: 'stderr', level: 'error', message: 'boom' });
  });

  it('handles partial lines spanning multiple chunks', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    const src = Readable.from(['hel', 'lo\nwor', 'ld\n']);
    await w.attachStdout(src);
    await w.close();
    const lines = readLines(join(tmp, 'api.jsonl'));
    expect(lines.map((l) => l.message)).toEqual(['hello', 'world']);
  });

  it('flushes a final un-newlined chunk on close()', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    await w.attachStdout(Readable.from(['trailing']));
    await w.close();
    const lines = readLines(join(tmp, 'api.jsonl'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe('trailing');
  });

  it('mkdirp creates the log directory if it does not exist', async () => {
    const nested = join(tmp, 'deep', 'nested', 'logs');
    const w = new ServiceLogWriter({ service: 'api', logDir: nested });
    await w.close();
    expect(existsSync(join(nested, 'api.jsonl'))).toBe(true);
  });

  it('appendLine() writes a structured record without going through a stream', async () => {
    const w = new ServiceLogWriter({ service: 'api', logDir: tmp });
    await w.appendLine('stdout', 'info', 'direct write');
    await w.close();
    const lines = readLines(join(tmp, 'api.jsonl'));
    expect(lines[0]!.message).toBe('direct write');
  });
});
