import { defineConfig } from "vitest/config";
import { COMPOSE_REQUIRED } from "./_pool-manifest.js";

const composeGlobs = COMPOSE_REQUIRED.map((f) => `**/${f}`);

// Two vitest projects:
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
// See docs/superpowers/specs/2026-05-25-e2e-suite-solid-and-fast-design.md
// for the full design.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "fast",
          include: ["**/*.test.ts"],
          exclude: ["node_modules/**", ...composeGlobs],
          pool: "forks",
          poolOptions: { forks: { singleFork: false, maxForks: 4 } },
          testTimeout: 30_000,
          hookTimeout: 20_000,
        },
      },
      {
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
    ],
  },
});
