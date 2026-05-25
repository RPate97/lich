import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    // Only exclude node_modules — the `include` pattern already filters to
    // `*.test.ts` files, so helper utility modules (helpers/lich.ts,
    // helpers/state.ts, etc.) are skipped by name. Their colocated unit
    // tests (helpers/urls.test.ts, helpers/wait.test.ts, etc.) DO get
    // collected — the previous `helpers/**` exclude was overly broad and
    // hid them from the suite, defeating their regression coverage.
    exclude: ["node_modules/**"],
    testTimeout: 120_000, // e2e is slow; 2 minutes per test
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // serialize e2e tests; they share docker
      },
    },
  },
});
