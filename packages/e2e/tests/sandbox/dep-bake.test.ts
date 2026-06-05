import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTartAvailable, imageExists } from '../../helpers/tart.js';
import { RealMutagenCli, isMutagenAvailable } from '../../../lich/src/sandbox/mutagen.js';

// Proves the dep-bake payoff end-to-end: cold-boot installs node_modules via
// before_up inside the VM, snapshot bakes it into the golden, second worktree
// with the same bake-inputs hash warm-forks the golden, and the baked
// node_modules survives the fork (no reinstall). Per-test sandbox-block
// injection lifted from bake-fork-share.test.ts — adding runtime.sandbox to
// the shared fixture would break every fast-pool test that relies on dev:fast.

const LICH = process.env.LICH ?? `${process.cwd()}/../lich/dist/lich`;
const FIXTURE = join(__dirname, '../../fixtures/dogfood-stack');
const PROFILE = 'dev:sandbox';

let mutagenOk = false;
try { mutagenOk = await isMutagenAvailable(new RealMutagenCli()); } catch { mutagenOk = false; }

function injectSandboxProfile(yamlPath: string): void {
  const yaml = readFileSync(yamlPath, 'utf8');
  if (!/^runtime:\s*$/m.test(yaml)) {
    throw new Error('dogfood-stack/lich.yaml no longer has a top-level `runtime:` key; update injection logic');
  }
  if (!/^profiles:\s*$/m.test(yaml)) {
    throw new Error('dogfood-stack/lich.yaml no longer has a top-level `profiles:` key; update injection logic');
  }
  const withRuntime = yaml.replace(
    /^runtime:\s*$/m,
    [
      'runtime:',
      '  sandbox:',
      '    backend: tart',
      '    image: lich-sandbox-base',
      '    warm_fork: true',
      '    memory: 2048',
      '    bake_inputs:',
      '      - bun.lock',
      '      - package.json',
      '      - apps/api/package.json',
      '      - apps/web/package.json',
    ].join('\n'),
  );
  const withProfile = withRuntime.replace(
    /^profiles:\s*$/m,
    [
      'profiles:',
      `  "${PROFILE}":`,
      '    owned: [api, web]',
      '    lifecycle:',
      '      before_up:',
      '        - "bun install --frozen-lockfile && touch /workspace/node_modules/.BAKED_SENTINEL"',
    ].join('\n'),
  );
  writeFileSync(yamlPath, withProfile);
}

function prepareWorktree(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lich-${name}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  // Make sure the host-side node_modules doesn't already exist in the fixture
  // copy — mutagen would otherwise sync it (it's in ALWAYS_IGNORE so it
  // shouldn't, but we're verifying that invariant in test 3 too).
  try { rmSync(join(dir, 'node_modules'), { recursive: true, force: true }); } catch { /* ok */ }
  injectSandboxProfile(join(dir, 'lich.yaml'));
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

describe.skipIf(!isTartAvailable() || !imageExists() || !mutagenOk)(
  'fork inherits baked node_modules (dep-bake e2e)',
  () => {
    let wt1: string;
    let wt2: string;
    let wt3: string;
    let lichHome: string;

    beforeAll(() => {
      lichHome = mkdtempSync(join(tmpdir(), 'lich-depbake-home-'));
      wt1 = prepareWorktree('depbake-wt1');
      wt2 = prepareWorktree('depbake-wt2');
      wt3 = prepareWorktree('depbake-wt3');
    }, 300_000);

    afterAll(() => {
      for (const wt of [wt1, wt2, wt3]) {
        try {
          execSync(`${LICH} down ${PROFILE} --purge`, {
            cwd: wt,
            env: { ...process.env, LICH_HOME: lichHome },
            stdio: 'ignore',
            timeout: 120_000,
          });
        } catch { /* best-effort */ }
      }
      try {
        execSync(`${LICH} nuke --yes`, {
          cwd: wt1,
          env: { ...process.env, LICH_HOME: lichHome },
          stdio: 'ignore',
          timeout: 120_000,
        });
      } catch { /* best-effort */ }
      for (const wt of [wt1, wt2, wt3, lichHome]) {
        try { rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }, 600_000);

    test('warm-fork inherits baked node_modules; no reinstall on second up', () => {
      // wt1 cold-boot: bun install runs in-VM via before_up, then writes
      // .BAKED_SENTINEL inside /workspace/node_modules. Mutagen's
      // ALWAYS_IGNORE skips node_modules, so the sentinel lives on the VM
      // disk only — exactly what we want to bake.
      const wt1Up = runLich(`up ${PROFILE}`, wt1, lichHome, 1_200_000, { capture: true });
      expect(wt1Up).toMatch(/cold-booted/);

      // Sanity: node_modules with the sentinel exist inside the VM.
      const lsCold = runLich(
        `exec -- sh -c "test -f /workspace/node_modules/.BAKED_SENTINEL && echo OK || echo MISSING"`,
        wt1,
        lichHome,
        60_000,
        { capture: true },
      );
      expect(lsCold).toContain('OK');

      // bake-on-down (default warm_fork=true) snapshots the golden, then
      // purges the run VM. Subsequent up in any worktree with the same
      // bake-inputs hash should fork the golden.
      runLich(`down ${PROFILE} --purge`, wt1, lichHome, 600_000);

      // wt2: identical bake_inputs → same hash → warm-fork.
      const wt2Up = runLich(`up ${PROFILE}`, wt2, lichHome, 600_000, { capture: true });
      expect(wt2Up).toMatch(/warm-forked/);

      // The fork must have inherited the baked node_modules. The sentinel
      // file is the proof: it was written inside the VM during the cold
      // bake's before_up, baked into the golden disk, and CoW-cloned into
      // the fork. If before_up had re-run on the fork (i.e. LICH_SKIP_BAKED
      // wasn't honored), the sentinel would also be there — but bun
      // install would have been re-invoked. The "warm-forked" status above
      // is the assertion that before_up was skipped; the sentinel below is
      // the assertion that the bake actually landed on disk.
      const lsFork = runLich(
        `exec -- sh -c "test -f /workspace/node_modules/.BAKED_SENTINEL && echo OK || echo MISSING"`,
        wt2,
        lichHome,
        60_000,
        { capture: true },
      );
      expect(lsFork).toContain('OK');

      // And node_modules is non-trivial — bun install actually populated
      // it during cold-boot. >= 10 entries comfortably distinguishes "real
      // install" from "stub directory with just the sentinel".
      const countOut = runLich(
        `exec -- sh -c "ls /workspace/node_modules | wc -l"`,
        wt2,
        lichHome,
        60_000,
        { capture: true },
      );
      expect(Number(countOut.trim())).toBeGreaterThanOrEqual(10);

      runLich(`down ${PROFILE} --purge`, wt2, lichHome, 600_000);
    }, 1_800_000);

    test('lockfile change in bake_inputs forces cold rebake on next up', () => {
      // Mutate a declared bake input → divergent hash → no matching
      // golden → cold-boot. Appending a comment to package.json is the
      // safest mutation: it changes the file bytes (so the hash diverges)
      // without breaking bun install (package.json supports a `//` field
      // for comments; bun ignores unknown top-level keys).
      const pkgPath = join(wt3, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg['//'] = 'dep-bake test mutation';
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

      const wt3Up = runLich(`up ${PROFILE}`, wt3, lichHome, 1_200_000, { capture: true });
      expect(wt3Up).toMatch(/cold-booted/);
      runLich(`down ${PROFILE} --purge`, wt3, lichHome, 600_000);
    }, 1_800_000);

    test('host node_modules never sync into the guest', () => {
      // ALWAYS_IGNORE invariant: even if the host has a node_modules
      // directory, mutagen must not copy it in (host arch != guest arch
      // would silently break everything, and the bake-on-down golden
      // would inherit a polluted node_modules).
      const wt4 = mkdtempSync(join(tmpdir(), 'lich-depbake-wt4-'));
      cpSync(FIXTURE, wt4, { recursive: true });
      injectSandboxProfile(join(wt4, 'lich.yaml'));
      mkdirSync(join(wt4, 'node_modules'), { recursive: true });
      writeFileSync(join(wt4, 'node_modules', '.HOST_SENTINEL'), 'leak\n');

      try {
        // Cold-boot installs into a fresh /workspace/node_modules from
        // inside the VM; the host sentinel must NOT be present.
        runLich(`up ${PROFILE}`, wt4, lichHome, 1_200_000);

        const leakOut = runLich(
          `exec -- sh -c "test -f /workspace/node_modules/.HOST_SENTINEL && echo LEAK || echo OK"`,
          wt4,
          lichHome,
          60_000,
          { capture: true },
        );
        expect(leakOut).toContain('OK');
      } finally {
        try { runLich(`down ${PROFILE} --purge`, wt4, lichHome, 600_000); } catch { /* best-effort */ }
        try { rmSync(wt4, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }, 1_800_000);
  },
  1_800_000,
);
