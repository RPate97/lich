// Single source of truth for tests needing the compose pool (singleFork, dev
// profile, real DB). Everything else runs in the fast pool. New compose tests:
// add the basename here, call `runLich(["up", "dev"], ...)`, and assert
// `expectDbMode(apiUrl, "live")` in beforeAll.

export const COMPOSE_REQUIRED: readonly string[] = [
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
] as const;
