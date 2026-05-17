import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Node 18.x doesn't expose `crypto` as a global by default; Better Auth's
    // random/ID helpers rely on the Web Crypto global. Polyfill it before any
    // module that touches it loads.
    setupFiles: ['./tests/setup.ts'],
    // Docker tests share the global daemon as a resource. Run all tests serially
    // in a single fork to avoid cross-test container/port contention. The unit-only
    // tests are fast enough that serial execution adds negligible overhead, and
    // the docker tests dominate suite duration regardless.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
