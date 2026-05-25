// Single source of truth for which e2e tests need the compose pool
// (singleFork, dev profile, real DB). Everything not listed here runs
// in the fast pool (parallel forks, dev:fast profile, no DB).
//
// Adding a new compose-requiring test:
//   1. Add the filename here (just the basename, e.g. "foo.test.ts").
//   2. In the test, call runLich(["up", "dev"], ...) — NOT runLich(["up"], ...).
//   3. In the test's beforeAll (after waitForHttp200 on /health), call
//      `await expectDbMode(apiUrl, "live");`.
//
// Target: ≤8 entries. If larger, the audit found a coverage pattern
// we didn't anticipate — document why in AUDIT.md.

export const COMPOSE_REQUIRED: readonly string[] = [
  "env-dotenv.test.ts",
  "env-groups-isolation.test.ts",
  "lifecycle-env-group.test.ts",
  "profiles-env-override.test.ts",
] as const;
