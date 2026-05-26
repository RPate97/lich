import { defineWorkspace } from "vitest/config";
import { COMPOSE_REQUIRED } from "./_pool-manifest";

const composeGlobs = COMPOSE_REQUIRED.map((f) => `**/${f}`);

// Vitest workspace: two projects, sharing the same root but with
// different include/exclude + pool config.
//
//   - "fast"  : everything except COMPOSE_REQUIRED tests. Runs the
//               default dev:fast profile (no docker, no postgres).
//               Parallel forks (maxForks: 4) since tests don't share
//               docker state. Tighter timeouts — no compose excuse.
//
//   - "compose" : just the COMPOSE_REQUIRED tests. Runs the dev profile
//                 (with postgres). singleFork: true because all stacks
//                 share the host docker daemon and concurrent compose-ups
//                 would conflict on docker network/state. Larger timeouts
//                 to accommodate postgres healthcheck + after_up.
//
// Vitest 1.6 uses the workspace API (top-level `vitest.workspace.ts`
// or workspace array). The `projects` key inside test.config landed in
// vitest 2.0+; we're on 1.6 per package.json.
//
// See docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md
// for the full design.
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "fast",
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**", ...composeGlobs],
      pool: "forks",
      // singleFork:true — the cross-LICH_HOME port allocator race
      // (each test's ports.json is isolated from peers') and the daemon's
      // pinned proxy_port: 3300 both make parallel fast-pool unreliable.
      // Per-test speed gains from dev:fast (~3s vs ~8s under dev) are
      // still preserved; we just don't get the 4x multiplier from
      // parallel forks. Revisit when (a) lich's allocator probes Docker's
      // port table AND (b) each test pins a unique proxy_port (see
      // friendly-urls.test.ts's pickProxyPort pattern, commit 9ef2c4e).
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 20_000,
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "compose",
      // When COMPOSE_REQUIRED is empty (Phase B not yet started),
      // use a placeholder glob so vitest doesn't accidentally include
      // all tests. Once the manifest is populated, the placeholder
      // is unused.
      include: composeGlobs.length > 0 ? composeGlobs : ["__no-files__"],
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 120_000,
      hookTimeout: 60_000,
    },
  },
]);
