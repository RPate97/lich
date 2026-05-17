import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';

/**
 * Shared vitest defaults for the monorepo.
 *
 * Docker-backed tests share the global daemon as a resource, so we force a
 * single fork to avoid cross-test container/port contention. Unit-only tests
 * are fast enough that serial execution adds negligible overhead, and the
 * docker tests dominate suite duration regardless.
 */
export const sharedVitestConfig: UserConfig = defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

/**
 * Helper for packages to extend the shared config with their own overrides.
 *
 * Usage:
 *   import { defineConfigShared } from '../../vitest.shared';
 *   export default defineConfigShared({
 *     test: { include: ['tests/**\/*.test.ts'] },
 *   });
 */
export function defineConfigShared(overrides: UserConfig = {}): UserConfig {
  return mergeConfig(sharedVitestConfig, defineConfig(overrides));
}
