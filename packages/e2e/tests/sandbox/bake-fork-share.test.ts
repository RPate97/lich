import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTartAvailable, imageExists } from '../../helpers/tart.js';

const LICH = process.env.LICH ?? `${process.cwd()}/../lich/dist/lich`;
const FIXTURE = join(__dirname, '../../fixtures/dogfood-stack');
const PROFILE = 'dev:heavy';

// Inject the sandbox runtime block into a copy of dogfood-stack's lich.yaml.
// Pattern lifted from sandbox-cold-up.test.ts — top-level runtime.sandbox is
// what flips `lich up` into sandbox mode (LICH source: commands/up.ts checks
// `!!config.runtime?.sandbox`), so adding the block to the shared fixture would
// silently break every fast-pool test. Per-test injection keeps the shared
// fixture clean.
function prepareWorktree(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lich-${name}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  execSync('bash scripts/generate-heavy-migrations.sh', { cwd: dir, stdio: 'inherit' });
  const yamlPath = join(dir, 'lich.yaml');
  const yaml = readFileSync(yamlPath, 'utf8');
  if (!/^runtime:\s*$/m.test(yaml)) {
    throw new Error('dogfood-stack/lich.yaml no longer has a top-level `runtime:` key; update injection logic');
  }
  const injected = yaml.replace(
    /^runtime:\s*$/m,
    'runtime:\n  sandbox:\n    backend: tart\n    image: lich-sandbox-base\n    bake_inputs: ["db/migrations/**", "db/migrations-heavy/**", "db/seed-heavy.sql"]',
  );
  writeFileSync(yamlPath, injected);
  return dir;
}

function runLich(args: string, cwd: string, lichHome: string, timeout: number, opts: { capture?: boolean } = {}): string {
  return execSync(`${LICH} ${args}`, {
    cwd,
    env: { ...process.env, LICH_HOME: lichHome },
    encoding: 'utf8',
    timeout,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  }) as unknown as string;
}

describe.skipIf(!isTartAvailable() || !imageExists())('bake-fork sharing/divergence (e2e)', () => {
  let wt1: string;
  let wt2: string;
  let wt3: string;
  let lichHome: string;

  beforeAll(() => {
    lichHome = mkdtempSync(join(tmpdir(), 'lich-bake-share-home-'));
    wt1 = prepareWorktree('bake-wt1');
    wt2 = prepareWorktree('bake-wt2');
    wt3 = prepareWorktree('bake-wt3');
  }, 300_000);

  afterAll(() => {
    for (const wt of [wt1, wt2, wt3]) {
      try { execSync(`${LICH} down ${PROFILE} --purge`, { cwd: wt, env: { ...process.env, LICH_HOME: lichHome }, stdio: 'ignore', timeout: 120_000 }); } catch { /* best-effort */ }
    }
    try { execSync(`${LICH} nuke --yes`, { cwd: wt1, env: { ...process.env, LICH_HOME: lichHome }, stdio: 'ignore', timeout: 120_000 }); } catch { /* best-effort */ }
    for (const wt of [wt1, wt2, wt3, lichHome]) {
      try { rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 600_000);

  test('identical bake_inputs → second worktree forks the same golden', () => {
    // wt1: cold-boot + bake-on-down (warm_fork default true).
    const wt1Up = runLich(`up ${PROFILE}`, wt1, lichHome, 900_000, { capture: true });
    expect(wt1Up).toMatch(/cold-booted/);
    runLich(`down ${PROFILE} --purge`, wt1, lichHome, 300_000);

    // wt2: same bake_inputs → should hit the warm-fork path.
    const wt2Up = runLich(`up ${PROFILE}`, wt2, lichHome, 600_000, { capture: true });
    expect(wt2Up).toMatch(/warm-forked/);
    runLich(`down ${PROFILE} --purge`, wt2, lichHome, 300_000);
  }, 1_800_000);

  test('changed bake_inputs → third worktree cold-boots (different hash)', () => {
    // Mutate a declared bake input — divergent hash → no matching golden → cold.
    writeFileSync(join(wt3, 'db/migrations/999_divergent.sql'), '-- divergent migration\n');
    const wt3Up = runLich(`up ${PROFILE}`, wt3, lichHome, 900_000, { capture: true });
    expect(wt3Up).toMatch(/cold-booted/);
    runLich(`down ${PROFILE} --purge`, wt3, lichHome, 300_000);
  }, 1_800_000);
});
