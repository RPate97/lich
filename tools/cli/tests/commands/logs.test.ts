import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/registry';
import { makeLogsCommand } from '../../src/commands/logs';
import { computeWorktreeKey } from '../../src/worktree';
import { CLIError } from '../../src/errors';

let projectDir: string;
let homeDir: string;
let registry: Registry;
let logDir: string;

function writeJsonl(service: string, records: Array<{ ts: string; stream: 'stdout' | 'stderr'; level: 'info' | 'error'; message: string }>) {
  const path = join(logDir, `${service}.jsonl`);
  const lines = records.map((r) => JSON.stringify({ ...r, service })).join('\n');
  writeFileSync(path, lines + (lines ? '\n' : ''));
}

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-logs-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-logs-home-')));
  writeFileSync(join(projectDir, 'levelzero.config.ts'), 'export default {};');
  registry = new Registry(join(homeDir, 'registry.json'));
  logDir = join(projectDir, '.levelzero', 'logs');
  mkdirSync(logDir, { recursive: true });
  await registry.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: {},
    urls: {},
    containers: [],
    network: '',
    logDir: '.levelzero/logs',
    createdAt: new Date().toISOString(),
  });
});

describe('levelzero logs', () => {
  it('errors NO_PROJECT when cwd is outside a levelzero project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lz-logs-outside-')));
    const cmd = makeLogsCommand(() => registry);
    await expect(
      cmd.run({ cwd: outside, format: 'json', args: [], flags: {} }),
    ).rejects.toThrow(CLIError);
  });

  it('returns empty lines + note when stack is not running', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'lz-logs-other-')));
    writeFileSync(join(other, 'levelzero.config.ts'), 'export default {};');
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: other, format: 'json', args: [], flags: {} })) as any;
    expect(result.lines).toEqual([]);
    expect(result.note).toMatch(/no stack/i);
  });

  it('returns all lines across all services, sorted by ts', async () => {
    writeJsonl('api', [
      { ts: '2026-05-17T00:00:02Z', stream: 'stdout', level: 'info', message: 'a2' },
      { ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'a1' },
    ]);
    writeJsonl('web', [
      { ts: '2026-05-17T00:00:03Z', stream: 'stdout', level: 'info', message: 'w3' },
    ]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: {} })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['a1', 'a2', 'w3']);
  });

  it('--service filter restricts to one service', async () => {
    writeJsonl('api', [{ ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'a1' }]);
    writeJsonl('web', [{ ts: '2026-05-17T00:00:02Z', stream: 'stdout', level: 'info', message: 'w2' }]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { service: 'api' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['a1']);
  });

  it('--service accepts a comma-separated list', async () => {
    writeJsonl('api', [{ ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'a' }]);
    writeJsonl('web', [{ ts: '2026-05-17T00:00:02Z', stream: 'stdout', level: 'info', message: 'w' }]);
    writeJsonl('worker', [{ ts: '2026-05-17T00:00:03Z', stream: 'stdout', level: 'info', message: 'wk' }]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { service: 'api,worker' } })) as any;
    expect(result.lines.map((l: any) => l.message).sort()).toEqual(['a', 'wk']);
  });

  it('--level filter restricts by log level', async () => {
    writeJsonl('api', [
      { ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'ok' },
      { ts: '2026-05-17T00:00:02Z', stream: 'stderr', level: 'error', message: 'bad' },
    ]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { level: 'error' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['bad']);
  });

  it('--grep filters by regex on message', async () => {
    writeJsonl('api', [
      { ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'GET /healthz 200' },
      { ts: '2026-05-17T00:00:02Z', stream: 'stdout', level: 'info', message: 'POST /api/foo 500' },
    ]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { grep: '50\\d' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['POST /api/foo 500']);
  });

  it('--since accepts ISO timestamps', async () => {
    writeJsonl('api', [
      { ts: '2026-05-17T00:00:01Z', stream: 'stdout', level: 'info', message: 'old' },
      { ts: '2026-05-17T00:00:05Z', stream: 'stdout', level: 'info', message: 'new' },
    ]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { since: '2026-05-17T00:00:03Z' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['new']);
  });

  it('--since accepts relative durations like -5m', async () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
    writeJsonl('api', [
      { ts: tenMinAgo, stream: 'stdout', level: 'info', message: 'old' },
      { ts: twoMinAgo, stream: 'stdout', level: 'info', message: 'recent' },
    ]);
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { since: '-5m' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['recent']);
  });

  it('--tail N returns the last N lines after other filters', async () => {
    writeJsonl('api', Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-05-17T00:00:0${i}Z`,
      stream: 'stdout' as const,
      level: 'info' as const,
      message: `line${i}`,
    })));
    const cmd = makeLogsCommand(() => registry);
    const result = (await cmd.run({ cwd: projectDir, format: 'json', args: [], flags: { tail: '3' } })) as any;
    expect(result.lines.map((l: any) => l.message)).toEqual(['line7', 'line8', 'line9']);
  });
});
