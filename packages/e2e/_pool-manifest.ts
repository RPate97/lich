// Single source of truth for tests that need the heavy pool — singleFork
// execution + long timeouts. Everything else runs in the fast pool.
//
// Two distinct reasons to be in this pool:
//   1. **docker compose** — needs the host docker daemon and `dev` profile
//      (postgres + migration + seed adds ~10-15s to each test). Run serial
//      because docker compose project names can race on parallel ups.
//   2. **sandbox / Tart** — needs an Apple Virtualization VM. Tart boots
//      cold in ~1s in isolation but the fast pool's accumulated memory
//      pressure (50+ dogfood-stack tests) starves later boots, so VMs
//      that should reach `running` in seconds time out at 30s when run
//      after the fast pool. Heavy pool's 120s test / 60s hook ceiling
//      absorbs that load + the test still skips if Tart isn't installed.
//
// When adding a new test: keep `expectDbMode("live")` for compose entries,
// and `describe.skipIf(!isTartAvailable())` for sandbox entries.

export const HEAVY_POOL_TESTS: readonly string[] = [
  // compose tests
  "dogfood-ready-when-cmd.test.ts",
  "env-dotenv.test.ts",
  "env-groups-isolation.test.ts",
  "exec.test.ts",
  "lifecycle-env-group.test.ts",
  "parallel-stacks.test.ts",
  "profiles-dev-lite.test.ts",
  "profiles-env-override.test.ts",
  "profiles-lifecycle-scoping.test.ts",
  "profiles-named.test.ts",
  // sandbox / Tart tests (dev-heavy-profile uses dev:heavy → postgres compose,
  // both heavy and compose-dependent)
  "bake-fork-share.test.ts",
  "dashboard-metrics-proxy.test.ts",
  "dep-bake.test.ts",
  "dev-heavy-profile.test.ts",
  "gc.test.ts",
  "mutagen-roundtrip.test.ts",
  "sandbox-cold-up.test.ts",
  "sandbox-full-loop.test.ts",
  "sandbox-tools.test.ts",
  "tart-lifecycle.test.ts",
  "tart-snapshot-fork.test.ts",
] as const;
