/**
 * LEV-211 — Multi-stack concurrency e2e.
 *
 * The whole point of the worktree-keyed model is that two stacks living in
 * two separate worktrees can run `dev` simultaneously without colliding.
 * Every isolation layer that exists today — per-worktreeKey port allocation
 * (LEV-200), per-worktreeKey compose project naming (LEV-202), the
 * registry's per-worktree lock acquisition, and the TEST_RUN_ID prefix that
 * keeps test stacks out of the user's namespace — needs an integration test
 * that exercises ALL of them together against real docker. A regression in
 * any single layer ships silently otherwise: the user already hit the "two
 * stacks fight for port 3000" symptom (LEV-200) before the fix, and that
 * class of bug has no unit-test surface — it only manifests when two real
 * stacks share a host.
 *
 * Suite layout — one scaffolded project per concurrent stack (A and B),
 * each living in its own OS tmpdir so the worktreeKey hash differs:
 *
 *   1. dev A + dev B sequentially → distinct allocated ports for both
 *      api-http and web-http (the LEV-200 fight class).
 *   2. compose project names differ + both are visible to docker ps —
 *      proves LEV-202's worktreeKey-suffixed naming actually produces two
 *      distinct compose projects, not one that B silently overwrites.
 *   3. /api/health on each api reaches its OWN stack (cross-checks the
 *      port allocation is correct end-to-end, not just internally consistent).
 *   4. `stacks list` from EITHER project sees BOTH stacks (registry is
 *      process-global, ~/.levelzero/registry.json).
 *   5. `stop` in project A leaves project B alive — the destructive case:
 *      without per-stack isolation, A's stop would tear B down too.
 *
 * Sequential `dev` is intentional. The goal is "two stacks coexist," not
 * "two stacks start in parallel" — parallelizing dev would add a layer of
 * racy assertions (which stack got which port?) without exercising any
 * behavior the sequential form misses.
 *
 * Watch-outs:
 *
 *   - **Address pool exhaustion** — two stacks consume two networks. On
 *     hosts with an undersized `default-address-pools` config, this is the
 *     test most likely to hit "all predefined address pools have been fully
 *     subnetted." LEV-202's doctor warning + globalSetup prune-on-startup
 *     covers the common case; if the test starts flaking with that error,
 *     file under doctor's hint and reconfigure docker.
 *   - **Registry lock contention** — both `dev` invocations acquire the
 *     global registry lock (~/.levelzero/registry.json.lock). Sequential
 *     dev means there's no contention here, but if the lock somehow times
 *     out under e2e load that's a finding worth its own ticket: the lock
 *     should be per-stack or fall back faster, not per-process. Report and
 *     escalate.
 *   - **Parallel install time** — setup uses `Promise.all` to do two
 *     scaffolds + installs concurrently. 8-min beforeAll budget is enough
 *     for a cold bun cache; warm runs come in around 60-90s combined.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';

import {
  setupScaffoldedProject,
  sweepStaleTmpdirs,
  teardownScaffoldedProject,
  type E2EProjectHandle,
} from './_helpers/setup';
import { runCli, runCliJson } from './_helpers/cli';
import { dockerAvailable } from './_helpers/docker';

const DOCKER = dockerAvailable();

let handleA: E2EProjectHandle;
let handleB: E2EProjectHandle;

/**
 * Shape of `levelzero dev --json` output we care about for this suite.
 * Pulled into a type alias so the per-it `let` declarations don't repeat
 * the structural cast and so a future change to the dev result shape
 * lands here in one place.
 */
interface DevJson {
  key: string;
  ports: Record<string, number>;
  compose: { projectName: string; file: string };
  detached?: boolean;
}

describe.skipIf(!DOCKER)('LEV-211 multi-stack concurrency (docker)', () => {
  beforeAll(async () => {
    // Sweep any stale concurrency-suite tmpdirs from prior aborted runs
    // before we claim two fresh ones. Same hygiene every other e2e file
    // follows (see M12 in LEV-206).
    sweepStaleTmpdirs('lz-e2e-concur-a-');
    sweepStaleTmpdirs('lz-e2e-concur-b-');

    // Parallel scaffold + install of two independent projects. The 8-min
    // hook budget is intentionally generous: a cold bun cache pulling
    // both installs back-to-back through `Promise.all` can take several
    // minutes, and we'd rather the hook complete than time out
    // mid-install and leak the half-scaffolded tree. If this hook starts
    // routinely timing out, fall back to sequential setup — the test's
    // value is "two stacks coexist," not "two setups run in parallel."
    [handleA, handleB] = await Promise.all([
      setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-concur-a-' }),
      setupScaffoldedProject({ tmpdirPrefix: 'lz-e2e-concur-b-' }),
    ]);
  }, 480_000);

  afterAll(async () => {
    // Best-effort parallel teardown. `Promise.allSettled` (not `Promise.all`)
    // so a failure to tear down A doesn't prevent B's cleanup from running
    // — both projects spun up docker resources we want released even on
    // the failure path.
    await Promise.allSettled([
      teardownScaffoldedProject(handleA),
      teardownScaffoldedProject(handleB),
    ]);
  }, 120_000);

  // Vitest runs `it`s within a `describe` sequentially in declaration
  // order, and the singleFork pool keeps this file in a single process,
  // so we share `devA` / `devB` between tests via outer-scope `let`s. Same
  // pattern lifecycle.e2e.test.ts uses for its dev/stop arc.
  let devA: DevJson;
  let devB: DevJson;

  it(
    'two parallel dev sessions return distinct allocated ports',
    { timeout: 360_000 },
    () => {
      // Sequential is fine — the assertion is "they coexist," not "they
      // start in parallel." Sequential also means a port-allocation
      // failure in B can't be racing A's compose-up; the failure mode
      // is cleanly attributable.
      const resA = runCliJson<DevJson>(
        handleA.projectDir,
        ['dev', '--json'],
        { timeoutMs: 180_000 },
      );
      devA = resA.json;
      handleA.setComposeProjectName(devA.compose.projectName);

      const resB = runCliJson<DevJson>(
        handleB.projectDir,
        ['dev', '--json'],
        { timeoutMs: 180_000 },
      );
      devB = resB.json;
      handleB.setComposeProjectName(devB.compose.projectName);

      // Both stacks must allocate api-http + web-http (the owned-service
      // port names plugin-hono + plugin-next declare).
      expect(devA.ports['api-http']).toBeDefined();
      expect(devB.ports['api-http']).toBeDefined();
      expect(devA.ports['web-http']).toBeDefined();
      expect(devB.ports['web-http']).toBeDefined();

      // The whole point of the test: ports must be distinct. Pre-LEV-200
      // both stacks would hardcode 3000 (api) and 3001 (web) regardless
      // of allocation — this assertion would fail loudly with both stacks
      // showing the same port. Post-LEV-200, the allocator's
      // `reservedPortsFromOtherStacks` keyed lookup excludes the other
      // stack's allocations and the two end up on distinct ports.
      expect(
        devA.ports['api-http'],
        `api-http collision: A=${devA.ports['api-http']} B=${devB.ports['api-http']}`,
      ).not.toBe(devB.ports['api-http']);
      expect(
        devA.ports['web-http'],
        `web-http collision: A=${devA.ports['web-http']} B=${devB.ports['web-http']}`,
      ).not.toBe(devB.ports['web-http']);

      // Postgres goes through compose port allocation as well — assert
      // it differs too so a regression in compose-side port allocation
      // also gets caught here. Both should be >= 54000 (the allocator's
      // base port range — same constraint lifecycle.e2e.test.ts asserts).
      expect(devA.ports.postgres).toBeGreaterThanOrEqual(54000);
      expect(devB.ports.postgres).toBeGreaterThanOrEqual(54000);
      expect(devA.ports.postgres).not.toBe(devB.ports.postgres);

      // Detached path is the default post-LEV-194. We don't pass --live
      // — if `detached` flips to undefined here, dev silently went
      // foreground (test would hang) so this assertion fails fast.
      expect(devA.detached).toBe(true);
      expect(devB.detached).toBe(true);
    },
  );

  it('compose project names are distinct (worktree-keyed) and docker-visible', () => {
    expect(devA.compose.projectName).toBeDefined();
    expect(devB.compose.projectName).toBeDefined();

    // Distinct names — proves LEV-202's worktreeKey-suffixed naming
    // actually produces two distinct compose projects, not one that B's
    // up silently overwrote. Under TEST_RUN_ID the names are
    // `levelzero-test-<run-id>-<worktreeKey>`; the run-id is shared (same
    // vitest invocation) but the worktreeKey differs (different tmpdir →
    // different sha256 hash), so the suffix is what disambiguates.
    expect(devA.compose.projectName).not.toBe(devB.compose.projectName);

    // Both project names should be docker-visible. We grep
    // `docker ps --filter name=levelzero-` (with the test-run prefix when
    // set) and assert each project name appears at least once. Using
    // execSync directly here rather than the runCli helper because this
    // is a host-level assertion about docker state, not a levelzero CLI
    // invocation.
    const composed = execSync(
      `docker ps --filter "name=levelzero-" --format "{{.Names}}"`,
      { encoding: 'utf8' },
    );
    expect(
      composed,
      `expected compose project ${devA.compose.projectName} in docker ps output:\n${composed}`,
    ).toContain(devA.compose.projectName);
    expect(
      composed,
      `expected compose project ${devB.compose.projectName} in docker ps output:\n${composed}`,
    ).toContain(devB.compose.projectName);
  });

  it(
    'GET /api/health on each api reaches its own stack',
    { timeout: 30_000 },
    async () => {
      // Detached `dev` returns once readiness probes pass per-service, but
      // a tiny buffer here covers the case where the post-`dev` registry
      // write completes before the OS-side socket is fully bound. 2s is
      // empirically enough on dev hardware; on slow CI we'd retry rather
      // than extend this further — but the readiness probe is the
      // authoritative gate.
      await new Promise((r) => setTimeout(r, 2000));

      const apiUrlA = `http://localhost:${devA.ports['api-http']}/api/health`;
      const apiUrlB = `http://localhost:${devB.ports['api-http']}/api/health`;

      const [rA, rB] = await Promise.all([
        fetch(apiUrlA).catch((err: Error) => {
          throw new Error(`fetch ${apiUrlA} failed: ${err.message}`);
        }),
        fetch(apiUrlB).catch((err: Error) => {
          throw new Error(`fetch ${apiUrlB} failed: ${err.message}`);
        }),
      ]);

      expect(rA.status, `A api ${apiUrlA} returned ${rA.status}`).toBe(200);
      expect(rB.status, `B api ${apiUrlB} returned ${rB.status}`).toBe(200);

      // Each api should report ok — proves the api process is fully booted
      // and not just bound to a port. This is the strongest end-to-end
      // signal that the two stacks are actually independent: if they were
      // both writing to the same upstream (DB, etc.) the health endpoint
      // would still return 200 but the underlying schemas would conflict.
      const bodyA = (await rA.json()) as { status: string };
      const bodyB = (await rB.json()) as { status: string };
      expect(bodyA.status).toBe('ok');
      expect(bodyB.status).toBe('ok');
    },
  );

  it('stacks list from either project sees BOTH stacks', () => {
    // The registry is process-global (~/.levelzero/registry.json), so a
    // `stacks list` invocation from EITHER project's CWD must return both
    // entries. This is the regression check that the registry doesn't
    // accidentally scope itself to the current worktree.
    const fromA = runCliJson<{
      stacks: Array<{ key: string; path: string }>;
    }>(handleA.projectDir, ['stacks', 'list', '--json']);

    const keys = fromA.json.stacks.map((s) => s.key);
    // We assert >=2 (not ===2) because sibling agents running other e2e
    // files on the same host may have their own stacks registered in the
    // same global registry under their own TEST_RUN_ID. Asserting
    // strict equality would false-fail under that condition. Both of
    // OUR stacks must be present though.
    expect(
      keys.length,
      `expected at least 2 stacks in registry, got ${keys.length}: ${JSON.stringify(keys)}`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      keys,
      `expected stack key ${devA.key} (project A) in registry`,
    ).toContain(devA.key);
    expect(
      keys,
      `expected stack key ${devB.key} (project B) in registry`,
    ).toContain(devB.key);

    // Sanity: the same query from B should produce a superset that also
    // contains both. If A and B were seeing different registries
    // (e.g. ~/.levelzero shadowed by CWD), this would expose it.
    const fromB = runCliJson<{
      stacks: Array<{ key: string; path: string }>;
    }>(handleB.projectDir, ['stacks', 'list', '--json']);
    const keysFromB = fromB.json.stacks.map((s) => s.key);
    expect(keysFromB).toContain(devA.key);
    expect(keysFromB).toContain(devB.key);
  });

  it(
    'stop in project A leaves project B alive',
    { timeout: 120_000 },
    async () => {
      // The destructive case: A's `stop` must scope to A's worktreeKey
      // and leave B's compose project + owned processes untouched. Pre-
      // LEV-202 (when stop's container kill was prefix-matched on
      // `levelzero-`) this would tear down B too; post-LEV-202 the
      // `levelzero-test-<run>-<keyA>` prefix is specific enough to
      // exclude `levelzero-test-<run>-<keyB>`.
      const stopA = runCli(handleA.projectDir, ['stop', '--json'], {
        timeoutMs: 90_000,
      });
      expect(stopA.exitCode, stopA.stderr).toBe(0);

      // Brief settle window for OS-side socket teardown. Without this the
      // next fetch can race the api shutdown and produce a confusing
      // "ECONNREFUSED" against B (which is still alive) just because the
      // event loop hadn't ticked yet.
      await new Promise((r) => setTimeout(r, 1000));

      // B's api should still respond — proves stop did NOT touch B.
      const apiUrlB = `http://localhost:${devB.ports['api-http']}/api/health`;
      const rB = await fetch(apiUrlB).catch((err: Error) => {
        throw new Error(
          `B's api at ${apiUrlB} unreachable after A's stop (regression): ${err.message}`,
        );
      });
      expect(
        rB.status,
        `B's api should still return 200 after A's stop; got ${rB.status}`,
      ).toBe(200);

      // And `stacks current` from A should now report running:false
      // while B's still reports running:true — the asymmetric stop
      // observed end-to-end.
      const curA = runCliJson<{ running: boolean }>(
        handleA.projectDir,
        ['stacks', 'current', '--json'],
      );
      expect(curA.json.running).toBe(false);

      const curB = runCliJson<{ running: boolean }>(
        handleB.projectDir,
        ['stacks', 'current', '--json'],
      );
      expect(
        curB.json.running,
        'B was torn down by A\'s stop — regression in per-stack isolation',
      ).toBe(true);
    },
  );
});
