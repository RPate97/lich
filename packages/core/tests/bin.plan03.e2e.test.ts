import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Registry } from '../src/registry';
import { computeWorktreeKey } from '../src/worktree';

const BIN = join(__dirname, '..', 'src', 'bin.ts');

let projectDir: string;
let homeDir: string;

beforeEach(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p03-proj-')));
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'lz-bin-p03-home-')));
  writeFileSync(join(projectDir, 'lich.config.ts'), 'export default {};');
  const reg = new Registry(join(homeDir, '.lich', 'registry.json'));
  await reg.upsert(computeWorktreeKey(projectDir), {
    path: projectDir,
    branch: 'main',
    ports: {},
    urls: {},
    containers: [],
    network: '',
    logDir: '.lich/logs',
    createdAt: new Date().toISOString(),
  });
  const logDir = join(projectDir, '.lich', 'logs');
  mkdirSync(logDir, { recursive: true });
  const apiLines = [
    { ts: '2026-05-17T00:00:01Z', service: 'api', stream: 'stdout', level: 'info', message: 'GET /healthz 200' },
    { ts: '2026-05-17T00:00:02Z', service: 'api', stream: 'stderr', level: 'error', message: 'ERROR: db timeout' },
  ];
  const webLines = [
    { ts: '2026-05-17T00:00:03Z', service: 'web', stream: 'stdout', level: 'info', message: 'compiled successfully' },
  ];
  writeFileSync(join(logDir, 'api.jsonl'), apiLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(logDir, 'web.jsonl'), webLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

function run(args: string[]) {
  return spawnSync('bun', [BIN, ...args], {
    cwd: projectDir,
    env: { ...process.env, LICH_HOME: homeDir },
    encoding: 'utf8',
  });
}

describe('bin: logs command end-to-end', () => {
  // LEV-168 — all stdout JSON parses require `--json` now that pretty is the default.
  it('returns all log lines sorted by ts', () => {
    const res = run(['logs', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.lines.map((l: any) => l.message)).toEqual([
      'GET /healthz 200',
      'ERROR: db timeout',
      'compiled successfully',
    ]);
  });

  it('--service api filters to just api', () => {
    const res = run(['logs', '--service', 'api', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.lines.every((l: any) => l.service === 'api')).toBe(true);
    expect(out.lines).toHaveLength(2);
  });

  it('--level error filters to errors', () => {
    const res = run(['logs', '--level', 'error', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.lines.map((l: any) => l.message)).toEqual(['ERROR: db timeout']);
  });

  it('--grep ERROR filters by regex on message', () => {
    const res = run(['logs', '--grep', 'ERROR', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.lines.map((l: any) => l.message)).toEqual(['ERROR: db timeout']);
  });

  it('--tail 1 returns the most recent line', () => {
    const res = run(['logs', '--tail', '1', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.lines.map((l: any) => l.message)).toEqual(['compiled successfully']);
  });
});
