import { defineWorkspace } from "vitest/config";
import { HEAVY_POOL_TESTS } from "./_pool-manifest";

const heavyGlobs = HEAVY_POOL_TESTS.map((f) => `**/${f}`);

// Two projects, same root, different include/pool config:
//   - "fast"  : everything except HEAVY_POOL_TESTS, dev:fast profile (no docker).
//   - "heavy" : just HEAVY_POOL_TESTS, singleFork + longer timeouts. Covers
//               both docker-compose-dependent tests (dev profile) and Tart
//               sandbox tests (need ~free host RAM for VM boot).
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "fast",
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**", ...heavyGlobs],
      pool: "forks",
      // singleFork: the cross-LICH_HOME port allocator race and the daemon's
      // pinned proxy_port:3300 both make parallel fast-pool unreliable.
      // Revisit once (a) the allocator probes Docker's port table and
      // (b) each test pins a unique proxy_port.
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 20_000,
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "heavy",
      // Placeholder glob avoids accidentally including all tests when
      // HEAVY_POOL_TESTS is empty.
      include: heavyGlobs.length > 0 ? heavyGlobs : ["__no-files__"],
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 120_000,
      hookTimeout: 60_000,
    },
  },
]);
