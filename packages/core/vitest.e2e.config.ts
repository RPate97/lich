/**
 * E2E vitest config — dogfood tier (`tests/e2e/*.e2e.test.ts`).
 *
 * Why a separate config (vs. inlining a longer timeout in `vitest.config.ts`):
 *   - The dogfood suite is opt-in. `bun run test` should NOT pull it in by
 *     default; it costs ~5 minutes per run and requires docker + playwright.
 *   - Test timeouts here are aggressive: 240s per test, 240s for hooks. The
 *     unit suite uses the 5s default; mixing them in one config causes long
 *     hooks to mask hung unit tests.
 *
 * Invocation:
 *   bun run test:e2e
 *
 * The script in `package.json` passes `--config vitest.e2e.config.ts` so
 * the only thing this file does is widen timeouts and narrow the include
 * pattern.
 */
import { defineConfigShared } from '../../vitest.shared';

export default defineConfigShared({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // LEV-202 — stamp TEST_RUN_ID + sweep stale `lich-*` networks
    // from prior crashed runs. Same machinery as `vitest.config.ts`; the
    // e2e suite needs it just as badly since it spins up real compose
    // stacks per test file.
    globalSetup: ['./vitest.globalSetup.ts'],
    // Default per-test timeout — phases 1, 2, 5 finish in seconds; phase 3
    // (dev → migrate → stop) needs the headroom.
    testTimeout: 240_000,
    // beforeAll/afterAll budget. `installDeps` is the slowest hook — it
    // runs `bun install` with `file:` overrides for every workspace pkg,
    // which can take 60-180s on a cold bun cache.
    hookTimeout: 240_000,
  },
});
