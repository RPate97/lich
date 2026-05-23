import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "helpers/**"],
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
