import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Never send telemetry from the test suite. Set on the runner process so
    // any child processes (spawned binaries, etc.) inherit it.
    env: {
      LICH_TELEMETRY: "0",
    },
  },
});
