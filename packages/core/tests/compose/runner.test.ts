import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerOrSkip, dockerStackTeardown } from '../_helpers/docker';
import { makeComposeRunner } from '../../src/compose/runner';

const status = dockerOrSkip();
const describeIfDocker = status.available ? describe : describe.skip;

// Use a fixed project name so a stray failed run can be cleaned up
// pre-emptively in beforeAll. Suffix is random enough to avoid collisions
// with other repos but stable within this test file.
const PROJECT = 'levelzero-compose-runner-test';

// A minimal postgres-with-healthcheck compose. Healthcheck lets us exercise
// `up({ waitForHealthy: true })` and gives `ps` a non-trivial state to assert.
const COMPOSE = `
name: ${PROJECT}
services:
  pg:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: testpw
      POSTGRES_USER: testuser
      POSTGRES_DB: testdb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U testuser -d testdb"]
      interval: 2s
      timeout: 3s
      retries: 15
      start_period: 2s
`;

function forceCleanup(file: string) {
  // -v removes named volumes; --remove-orphans drops any stragglers.
  spawnSync('docker', ['compose', '-p', PROJECT, '-f', file, 'down', '-v', '--remove-orphans'], {
    stdio: 'ignore',
  });
  // LEV-202 — belt-and-suspenders: sweep any networks compose may have left
  // behind on partial-up failures so the host's address pool doesn't
  // accumulate orphans across runs.
  dockerStackTeardown(PROJECT);
}

describeIfDocker('makeComposeRunner (real docker)', () => {
  let workDir: string;
  let composeFile: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lev-compose-runner-'));
    composeFile = join(workDir, 'compose.yml');
    writeFileSync(composeFile, COMPOSE);
    forceCleanup(composeFile);
  });

  afterEach(() => {
    forceCleanup(composeFile);
  });

  it('up({ waitForHealthy: true }) brings services up and waits for healthy', async () => {
    const runner = makeComposeRunner(PROJECT, composeFile);
    await runner.up({ waitForHealthy: true });

    const rows = await runner.ps();
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toContain('pg');
    expect(rows[0]!.state).toBe('running');
  }, 180_000);

  it('exec returns stdout / exit code from the container command', async () => {
    const runner = makeComposeRunner(PROJECT, composeFile);
    await runner.up({ waitForHealthy: true });

    const ok = await runner.exec('pg', ['pg_isready', '-U', 'testuser', '-d', 'testdb']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toMatch(/accepting connections/);

    // Non-zero exit codes are surfaced verbatim, not thrown.
    const bad = await runner.exec('pg', ['sh', '-c', 'exit 7']);
    expect(bad.exitCode).toBe(7);
  }, 180_000);

  it('logs returns captured stdout for a service', async () => {
    const runner = makeComposeRunner(PROJECT, composeFile);
    await runner.up({ waitForHealthy: true });

    const out = await runner.logs('pg', { tail: 50 });
    // Postgres prints a recognisable startup banner.
    expect(out).toMatch(/database system is ready to accept connections/i);
  }, 180_000);

  it('down({ volumes: true }) tears down containers and removes volumes', async () => {
    const runner = makeComposeRunner(PROJECT, composeFile);
    await runner.up({ waitForHealthy: true });
    await runner.down({ volumes: true });

    const rows = await runner.ps();
    expect(rows).toEqual([]);
  }, 180_000);

  // Best-effort cleanup of the tmp dir; harmless if absent.
  afterAll(() => {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
