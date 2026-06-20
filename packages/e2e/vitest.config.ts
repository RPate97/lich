import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Base config extended by the workspace projects (fast + compose).
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Mirror of tsconfig.json's `@/*` alias — vitest 1.6 doesn't auto-read
  // tsconfig paths. Bun honors them natively; the two agree.
  resolve: {
    alias: {
      "@": here,
    },
  },
  test: {
    // include/exclude live on the workspace projects; defining them here
    // ANDs with the project's and produces empty intersections.
    //
    // Never send telemetry from e2e tests. Set on the runner process so
    // every spawned lich invocation inherits it via process.env.
    env: {
      LICH_TELEMETRY: "0",
    },
  },
});
