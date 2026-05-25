import { defineConfig } from "vitest/config";

// Base config shared by both workspace projects (fast + compose). The
// workspace file (vitest.workspace.ts) extends this and adds per-project
// pool/include/exclude/timeout overrides.
//
// Why the base sits here separately: vitest 1.6's workspace extends:
// expects a config file, and having a base lets shared concerns
// (typecheck, globals, etc.) live in one place even though we don't
// currently set them.
export default defineConfig({
  test: {
    // Don't define `include`/`exclude` here — the workspace projects
    // own those. Defining them here would AND with the project's, which
    // produces empty intersections in some cases.
  },
});
