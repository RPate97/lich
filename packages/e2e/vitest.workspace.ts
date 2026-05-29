import { defineWorkspace } from "vitest/config";
import { COMPOSE_REQUIRED } from "./_pool-manifest";

const composeGlobs = COMPOSE_REQUIRED.map((f) => `**/${f}`);

// Two projects, same root, different include/pool config:
//   - "fast"    : everything except COMPOSE_REQUIRED, dev:fast profile (no docker).
//   - "compose" : just COMPOSE_REQUIRED, dev profile, singleFork (host docker
//                 daemon serializes), larger timeouts for postgres + after_up.
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "fast",
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**", ...composeGlobs],
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
      name: "compose",
      // Placeholder glob avoids accidentally including all tests when
      // COMPOSE_REQUIRED is empty.
      include: composeGlobs.length > 0 ? composeGlobs : ["__no-files__"],
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 120_000,
      hookTimeout: 60_000,
    },
  },
]);
