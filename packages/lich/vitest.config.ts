import { defineConfig } from "vitest/config";

// NOTE: `bun test` (used by `npm test`) does NOT read this file. The real
// test-time telemetry disable lives in bunfig.toml's [test] preload, which
// runs tests/disable-telemetry-setup.ts before any test file loads. This
// config is retained only for ad-hoc `vitest run` invocations and for IDE
// integrations that read it for project shape.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/disable-telemetry-setup.ts"],
  },
});
