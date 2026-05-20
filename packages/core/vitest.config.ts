import { defineConfigShared } from '../../vitest.shared';

export default defineConfigShared({
  test: {
    include: ['tests/**/*.test.ts'],
    // LEV-198 — the dogfood tier (`tests/e2e/**`) runs the real CLI as a
    // subprocess against a real-installed scaffold and takes ~5 minutes per
    // invocation. Keep it out of the default `bun run test` path; invoke it
    // explicitly via `bun run test:e2e` (uses `vitest.e2e.config.ts`).
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    // Node 18.x doesn't expose `crypto` as a global by default; Better Auth's
    // random/ID helpers rely on the Web Crypto global. Polyfill it before any
    // module that touches it loads.
    setupFiles: ['./tests/setup.ts'],
  },
});
