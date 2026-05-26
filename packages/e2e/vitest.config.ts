import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Base config shared by both workspace projects (fast + compose). The
// workspace file (vitest.workspace.ts) extends this and adds per-project
// pool/include/exclude/timeout overrides.
//
// Why the base sits here separately: vitest 1.6's workspace `extends:`
// expects a config file, and having a base lets shared concerns
// (resolve aliases, typecheck, globals, etc.) live in one place.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Path alias mirror of packages/e2e/tsconfig.json's `@/*`. Vitest 1.6
  // doesn't auto-read tsconfig paths, so we declare the same alias here
  // for the test runtime. Bun honors tsconfig paths natively; the two
  // mappings agree, so both runners resolve `@/helpers/paths.js` the
  // same way.
  resolve: {
    alias: {
      "@": here,
    },
  },
  test: {
    // Don't define `include`/`exclude` here — the workspace projects
    // own those. Defining them here would AND with the project's, which
    // produces empty intersections in some cases.
  },
});
