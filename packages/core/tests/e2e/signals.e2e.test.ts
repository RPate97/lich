/**
 * LEV-209 — Real-SIGINT end-to-end regression coverage for LEV-199 (registry
 * lock cleanup on Ctrl-C) and LEV-203 (`dev --live` compose teardown on
 * Ctrl-C).
 *
 * Both bugs were fixed in the unit tier, but the unit tests stub out spawn
 * + signal delivery — they prove "the handlers fire and call the right
 * cleanups in isolation," not "a real `lich dev` process actually
 * cleans up when the user hits Ctrl-C." This file closes that gap by
 * spawning a real subprocess (`spawnCli`) and sending a real `SIGINT`.
 *
 * Three tests:
 *
 *   1. LEV-199 stale-lock reclaim (no docker): pre-write a lock file
 *      pointing at a dead PID, run `lich stop --json` against an empty
 *      registry. `acquireLock`'s reclaim path should unlink the stale lock,
 *      proceed, and release cleanly. Asserts lock file absent after.
 *
 *   2. LEV-199 SIGINT-during-dev lock release (docker-gated): spawn `dev
 *      --json`, poll the lock file until it appears (i.e. the
 *      bring-up flow has reached the `withLock` body), send SIGINT, wait
 *      for exit, assert the lock file is gone.
 *
 *   3. LEV-203 SIGINT-during-`dev --live` compose teardown (docker-gated):
 *      spawn `dev --live --json`, wait for the registry entry to appear
 *      (i.e. the compose `up` finished and we're now in the foreground
 *      `runOwnedServices` phase), assert the compose container exists,
 *      send SIGINT, wait for exit, poll until the compose container is
 *      gone.
 *
 * These are intentionally NOT in `dogfood.e2e.test.ts` — dogfood is the
 * canonical happy-path coverage map; signals get their own file so a
 * future signal-related regression (e.g. SIGTERM, two-Ctrl-C escape,
 * etc.) has an obvious home to grow into.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { scaffoldProject } from './_helpers/scaffold';
import { installDeps } from './_helpers/install';
import { runCli, spawnCli } from './_helpers/cli';
import { dockerAvailable, dockerComposeDown } from './_helpers/docker';

const DOCKER = dockerAvailable();

const PROJECT_NAME = 'demo';

let tmpdir: string;
let projectDir: string;
/** Per-suite isolated `LICH_HOME` so the test never touches the user's real registry. */
let homeDir: string;
let registryPath: string;
let registryLockPath: string;
/**
 * Captured at end-of-bring-up so `afterAll` knows which docker project to
 * tear down even if a test failed before its cleanup ran.
 */
let composeProjectName: string | null = null;

/**
 * Resolve the host-context env we hand to the spawned `lich` process.
 * `LICH_HOME` redirects `registry.json` to our scratch dir. `TEST_RUN_ID`
 * (inherited from the vitest globalSetup) keeps compose names namespaced so
 * a sibling agent running the same test can't trample us.
 */
function spawnEnv(): Record<string, string> {
  return { LICH_HOME: homeDir };
}

/**
 * Promise-based poll: invoke `check` every `intervalMs` until it returns
 * truthy, or reject after `timeoutMs`. Tiny dependency-free reimplementation
 * of `wait-for-expect` — vitest's `vi.waitFor` exists but doesn't ship
 * configurable intervals in this codebase's pinned version.
 */
async function waitFor<T>(
  check: () => T | Promise<T>,
  opts: { timeoutMs: number; intervalMs?: number; description?: string } = {
    timeoutMs: 15_000,
  },
): Promise<T> {
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  throw new Error(
    `waitFor timed out after ${opts.timeoutMs}ms` +
      (opts.description ? ` (${opts.description})` : '') +
      (lastErr ? `\nlast error: ${(lastErr as Error).message}` : ''),
  );
}

/**
 * Returns the docker container ids matching `name~=<filter>`. Empty string
 * means none. We use `docker ps -q --filter` because it's the canonical
 * "is this thing running" probe across docker engine versions and works
 * even when compose isn't installed.
 */
function dockerPsIds(nameFilter: string): string {
  const r = spawnSync(
    'docker',
    ['ps', '-q', '--filter', `name=${nameFilter}`],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

describe('LEV-209 real-SIGINT end-to-end', () => {
  beforeAll(async () => {
    tmpdir = realpathSync(mkdtempSync(join(osTmpdir(), 'lz-e2e-signals-')));
    homeDir = join(tmpdir, 'home');
    mkdirSync(homeDir, { recursive: true });
    registryPath = join(homeDir, '.lich', 'registry.json');
    registryLockPath = `${registryPath}.lock`;

    const { projectDir: dir } = await scaffoldProject({
      tmpdir,
      projectName: PROJECT_NAME,
    });
    projectDir = dir;

    // Real `bun install` against the workspace overrides so
    // `node_modules/.bin/lich` is materialized — `spawnCli` resolves
    // that bin directly (matching what the user types).
    await installDeps(projectDir);
  }, 240_000);

  afterAll(async () => {
    // Best-effort: tear down anything any test left running. The signals
    // tests intentionally kill `dev` mid-flight, so a partial bring-up may
    // have leaked compose resources we have to sweep ourselves.
    try {
      if (projectDir) {
        runCli(projectDir, ['down', '--json'], {
          timeoutMs: 30_000,
          env: spawnEnv(),
        });
      }
    } catch {
      /* best-effort */
    }
    try {
      if (composeProjectName) dockerComposeDown(composeProjectName);
    } catch {
      /* best-effort */
    }
    try {
      if (tmpdir) rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Test 1 — LEV-199 stale-lock reclaim (no docker required).
  //
  // The bug pre-LEV-199: a previous `dev` killed with SIGKILL would leave a
  // zero-byte `registry.json.lock` behind. The next `dev` would hang 30s
  // waiting for the phantom holder, then time out with `LockTimeoutError`.
  // LEV-199 layer 3 fixes this by writing the holder's PID into the lock and
  // reclaiming the lock on acquire if the recorded PID is dead.
  //
  // We can exercise this WITHOUT spawning anything long-lived: hand-write a
  // lock file referencing PID 99999999 (effectively guaranteed dead — Linux
  // PIDs cap at 4_194_303 by default, macOS at 99998), then run any command
  // that uses `withLock`. `stop` against an empty registry exits early
  // (entry-not-found returns immediately without docker) — perfect.
  // ---------------------------------------------------------------------------
  it('LEV-199 regression: stale lock with dead PID is reclaimed (no docker)', () => {
    // Make sure the registry dir exists — `stop` would create it on its
    // own, but we need it to drop the stale lock first.
    mkdirSync(join(homeDir, '.lich'), { recursive: true });
    // Write the stale lock pointing at a deliberately-dead PID. The reclaim
    // logic in `registry-lock.ts` calls `process.kill(pid, 0)` and treats
    // ESRCH as "stale, reclaim ok." PID 99999999 has never existed on any
    // unix this test runs on.
    writeFileSync(registryLockPath, '99999999', 'utf8');
    expect(existsSync(registryLockPath)).toBe(true);

    // `stop` with no entry exits early after `withLock` body runs `reg.get`
    // and finds nothing — no docker invocation. The acquire path is what
    // we care about: it must reclaim the stale lock, do its work, and
    // release cleanly.
    const res = runCli(projectDir, ['down', '--json'], {
      timeoutMs: 30_000,
      env: spawnEnv(),
    });
    expect(res.exitCode, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { stopped: boolean };
    expect(parsed.stopped).toBe(false);

    // The lock file must be GONE after stop releases — both the reclaim
    // (which unlinked the original stale file) AND the release (which
    // unlinked the new acquire) must have happened.
    expect(
      existsSync(registryLockPath),
      'stale lock should have been reclaimed AND the fresh acquire released',
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — LEV-199 SIGINT during `dev` releases the lock (docker-gated).
  //
  // This is the proper signal-handler path: the lich process IS
  // holding the lock when SIGINT arrives, and the registered cleanup
  // (`releaseAllLocksSync` in `registry-lock.ts`) must synchronously
  // unlink it before the process exits.
  //
  // Strategy: spawn `dev --json`, poll for the lock file to appear (it's
  // written inside `acquireLock` immediately after the file is opened, with
  // the lich process's PID as the content), send SIGINT, wait for
  // exit, assert the lock is gone. We poll the FILE rather than waiting on
  // stdout because dev's JSON-mode stdout only emits at the very end (after
  // teardown), so there's no in-flight signal we could match on.
  //
  // The detached default-mode dev acquires the lock during compose
  // bring-up, releases it before spawning owned services, and exits. The
  // lock-held window covers `docker compose up`, which typically takes
  // several seconds — plenty of time to poll, observe, and SIGINT.
  // ---------------------------------------------------------------------------
  it.skipIf(!DOCKER)(
    'LEV-199 regression: SIGINT during up releases the registry lock',
    { timeout: 120_000 },
    async () => {
      // Wipe any leftover state from test 1 so we're starting from a
      // pristine home — including the registry file itself, which the
      // first test's `stop` may have created.
      try {
        rmSync(registryLockPath, { force: true });
        rmSync(registryPath, { force: true });
      } catch {
        /* fine */
      }

      const spawned = spawnCli(projectDir, ['up', '--json'], {
        env: spawnEnv(),
      });

      try {
        // Poll for the lock file. `acquireLock` writes the holder PID right
        // after opening, so seeing the file with our child's PID inside it
        // confirms we're inside the held window — exactly when the
        // signal-handler unlink path matters. We use a generous 30s budget
        // because compose bring-up is the slow step bounded by docker
        // network/image setup; 10s isn't enough on a cold daemon.
        await waitFor(
          () => {
            if (!existsSync(registryLockPath)) return false;
            // Make sure the PID inside is the child's (not a leftover from
            // some other process). Defensive — protects against a stray
            // lock file written by an unrelated lich invocation.
            const raw = readFileSync(registryLockPath, 'utf8').trim();
            const lockPid = Number(raw);
            return Number.isFinite(lockPid) && lockPid === spawned.proc.pid;
          },
          { timeoutMs: 30_000, intervalMs: 50, description: 'registry lock acquired' },
        );

        // Send the real SIGINT. The shared signal handler in
        // `signal-handlers.ts` runs every registered cleanup synchronously,
        // then exits 130. The cleanup we care about is
        // `releaseAllLocksSync` (registered by `registry-lock.ts`), which
        // walks `activeLockPaths` and unlinks each one.
        spawned.kill('SIGINT');

        // Give the process up to 30s to exit. Compose bring-up's stuck
        // states (image pull, network create on an exhausted address pool)
        // can take a while to abort even after SIGINT — the shared
        // signal-handler module has a 2s hard deadline for cleanups, but
        // the wider process may need a bit longer to fully unwind.
        const exit = await spawned.waitForExit(30_000);
        // Exit code on SIGINT should be 130 (convention: 128 + signal num)
        // OR the `signal` field should be SIGINT. macOS/Linux can differ
        // here depending on whether node propagates the signal or
        // intercepts it; accept either.
        const cleanExit =
          exit.signal === 'SIGINT' || exit.exitCode === 130;
        expect(cleanExit, `unexpected exit: ${JSON.stringify(exit)}`).toBe(true);

        // The whole point of LEV-199: after SIGINT, the lock file MUST be
        // gone. The synchronous `unlinkSync` in `releaseAllLocksSync` ran
        // inline with the signal handler, so this check is not racy — by
        // the time `waitForExit` resolved, the process has already exited
        // and every cleanup ran.
        expect(
          existsSync(registryLockPath),
          'registry lock should have been unlinked by the SIGINT cleanup',
        ).toBe(false);
      } finally {
        // Belt-and-suspenders teardown: if the test failed mid-flight we
        // may have a still-running child. Best-effort kill so the worker
        // doesn't hang.
        spawned.kill('SIGKILL');
        try {
          await spawned.waitForExit(5_000);
        } catch {
          /* may already be dead */
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Test 3 — LEV-203 SIGINT during `dev --live` tears down compose
  // (docker-gated).
  //
  // The pre-LEV-203 bug: `dev --live` ran api+web in the foreground via
  // `concurrently`. On Ctrl-C, concurrently killed its own children
  // (api+web died correctly), but the compose-managed services (postgres,
  // etc.) survived because nothing called `docker compose down`. Users
  // were left with orphan postgres containers eating ports until they
  // noticed and ran `docker ps`.
  //
  // The LEV-203 fix wires `teardownLiveStack` into the shared signal
  // handler via `addCleanup`. This test asserts the user-visible end
  // state: postgres container is GONE within a few seconds of the SIGINT
  // arriving.
  //
  // Strategy: spawn `dev --live --json`, wait for the registry entry to
  // appear (proves compose `up` finished — `dev`'s `withLock` body awaits
  // `runner.up({ waitForHealthy: true })` BEFORE writing the entry, so
  // entry presence guarantees the container is healthy), capture the
  // worktreeKey, confirm the postgres container is running, SIGINT, wait
  // for exit, poll until the container is gone.
  // ---------------------------------------------------------------------------
  it.skipIf(!DOCKER)(
    'LEV-203 regression: SIGINT during dev --live tears down compose containers',
    { timeout: 240_000 },
    async () => {
      // Belt-and-suspenders: the LEV-199 SIGINT test above may have left a
      // partially-brought-up compose stack behind (it interrupts `docker
      // compose up` mid-flight, and the LEV-199 cleanup only handles
      // lock-file cleanup — compose containers are out of scope for the
      // default-mode SIGINT path, by design). Run a real `lich stop`
      // to sweep any stragglers BEFORE we start a fresh `dev --live`, so
      // the registry entry / port allocation / docker network state is
      // pristine.
      try {
        runCli(projectDir, ['down', '--json'], {
          timeoutMs: 60_000,
          env: spawnEnv(),
        });
      } catch {
        /* stop is best-effort — if registry is empty, this is a no-op */
      }
      try {
        rmSync(registryLockPath, { force: true });
        rmSync(registryPath, { force: true });
      } catch {
        /* fine */
      }

      const spawned = spawnCli(projectDir, ['up', '--live', '--json'], {
        env: spawnEnv(),
      });

      // Inferred lazily once the registry entry exists.
      let projectNameLocal: string | null = null;

      try {
        // Wait for the registry file to contain an entry. Entry presence
        // implies `docker compose up --wait` returned (healthy), so we're
        // safely in the `runOwnedServices` foreground phase by the time
        // this matcher resolves. 150s ceiling covers cold-image pulls
        // (postgres can take 60+s to pull on a cold daemon) plus the
        // wait-for-healthy probe that compose runs after the container
        // starts. If this still trips, look at the docker logs for the
        // postgres container in the spawned project tree.
        await waitFor(
          () => {
            if (!existsSync(registryPath)) return false;
            try {
              const data = JSON.parse(readFileSync(registryPath, 'utf8')) as {
                stacks: Record<string, unknown>;
              };
              const keys = Object.keys(data.stacks ?? {});
              if (keys.length === 0) return false;
              const key = keys[0]!;
              // composeProjectName is `lich-<test-prefix>-<key>` —
              // see `compose/naming.ts`. We reproduce the format here
              // rather than importing the function so this test stays
              // decoupled from the worktree's source tree (it runs
              // against the installed `node_modules/@lich/core`).
              const prefix = process.env.TEST_RUN_ID
                ? `lich-test-${process.env.TEST_RUN_ID}-`
                : 'lich-';
              projectNameLocal = `${prefix}${key}`;
              composeProjectName = projectNameLocal;
              return true;
            } catch {
              return false;
            }
          },
          {
            timeoutMs: 150_000,
            intervalMs: 200,
            description:
              'dev --live registered stack (compose up + healthcheck completed)',
          },
        );

        const projectName = projectNameLocal!;

        // Confirm the compose stack actually has a running container so we
        // know there's something for the teardown to remove. `docker ps`
        // filtered by the project name returns IDs of every running
        // container in the project — postgres at minimum.
        const before = dockerPsIds(projectName);
        expect(
          before.length,
          `expected at least one running container for project ${projectName}, got none`,
        ).toBeGreaterThan(0);

        // Send the real SIGINT. Two SIGINT-handler chains fire in parallel:
        //
        //   (a) `concurrently`'s own `KillOnSignal` (registered when dev
        //       started `runOwnedServices`) catches SIGINT on the parent
        //       process and propagates it to api+web. concurrently treats
        //       a SIGINT exit as exit code 0 (its
        //       `flow-control/kill-on-signal.js` literally rewrites the
        //       child exit code to 0 — confirmed by code inspection of
        //       the pinned version in `node_modules`).
        //
        //   (b) lich's own shared `signal-handlers.ts` cleanup that
        //       runs `teardownLiveStack` → `docker compose down`.
        //
        // The race between bin's `process.exit(0)` (after dev's run()
        // returns the success result, since concurrently rewrote its
        // children's exit codes) and signal-handlers' `process.exit(130)`
        // means the OBSERVED exit code can be either 0 or 130 — and in
        // practice on this codebase it's usually 0 because the bin path
        // wins the race. That's NOT a bug: both cleanup paths still run
        // (state.promise dedupes the work). The user-visible LEV-203
        // invariant is "compose containers are gone after Ctrl-C," which
        // we assert below.
        spawned.kill('SIGINT');

        // Allow up to 30s for exit. The signal handler's hard deadline is
        // 2s for async cleanups, but the process body has its own
        // `runner.done` to settle (concurrently killing api+web). 30s is
        // comfortable; if we ever see exits taking 15+s consistently
        // that's a separate ticket.
        const exit = await spawned.waitForExit(30_000);
        // The only NON-ok outcome here is "didn't exit at all" (which
        // would throw from waitForExit) — both exitCode 0 (concurrently
        // rewrote the SIGINT to 0, bin's `process.exit(0)` won the race)
        // and exitCode 130 / signal 'SIGINT' (signal-handler dispatcher's
        // explicit `process.exit(130)` won) are acceptable. We assert
        // _something_ produced an exit just to surface a future bug where
        // the process hangs forever — anything else is signal-of-noise.
        expect(
          exit.exitCode !== null || exit.signal !== null,
          `process should have exited with some signal/code: ${JSON.stringify(exit)}`,
        ).toBe(true);

        // The whole point of LEV-203: the compose container is gone.
        // `docker compose down` may take a few seconds after the SIGINT
        // dispatches, so poll up to 20s. If we see it take longer in
        // practice this needs bumping — note in the test failure rather
        // than swallowing.
        await waitFor(
          () => dockerPsIds(projectName).length === 0,
          {
            timeoutMs: 20_000,
            intervalMs: 500,
            description: `containers for ${projectName} to vanish`,
          },
        );

        // Belt-and-suspenders: registry entry should also be gone — LEV-203
        // `teardownLiveStack` removes the entry after compose down. This
        // catches a subtle regression where the compose teardown succeeded
        // but the registry write was swallowed (which would leave `stacks
        // list` showing a phantom stack).
        const after = existsSync(registryPath)
          ? (JSON.parse(readFileSync(registryPath, 'utf8')) as {
              stacks: Record<string, unknown>;
            })
          : { stacks: {} };
        expect(Object.keys(after.stacks ?? {}).length).toBe(0);
      } finally {
        spawned.kill('SIGKILL');
        try {
          await spawned.waitForExit(5_000);
        } catch {
          /* may already be dead */
        }
        // Force a docker compose down even if assertions tripped — keeps
        // the next test (and parallel agents) from inheriting our mess.
        if (projectNameLocal) {
          try {
            dockerComposeDown(projectNameLocal);
          } catch {
            /* best-effort */
          }
        }
      }
    },
  );
});
