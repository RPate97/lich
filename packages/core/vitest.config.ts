import { defineConfigShared } from '../../vitest.shared';

export default defineConfigShared({
  test: {
    include: ['tests/**/*.test.ts'],
    // Node 18.x doesn't expose `crypto` as a global by default; Better Auth's
    // random/ID helpers rely on the Web Crypto global. Polyfill it before any
    // module that touches it loads.
    setupFiles: ['./tests/setup.ts'],
  },
});
