/**
 * Naming helpers for lich compose projects.
 *
 * These produce the stable names that compose, the registry, and operators
 * see — `lich-<key>` for the project/network, `lich-<key>-<service>`
 * for containers, and `lich-<key>-<service>-data` for named volumes.
 *
 * Validation guards (`assertKey`, `assertService`) reject inputs that would
 * produce ambiguous or shell-unsafe names; callers should treat throws here
 * as programmer errors, not user input issues.
 *
 * Previously lived at `src/docker/naming.ts` — moved here as part of LEV-134
 * when the legacy docker runner was deleted.
 *
 * LEV-202 — when the `TEST_RUN_ID` env var is set (vitest globalSetup
 * stamps this once per process), every name carries an additional
 * `test-${TEST_RUN_ID}-` infix so test stacks are isolated from real
 * user stacks AND from sibling agents running tests in parallel. The
 * resulting names still start with `LICH_PREFIX`, so global
 * sweep tools (`stacks prune --all`, `doctor`'s warn check) catch them.
 * Production code paths (TEST_RUN_ID unset) emit the historical names
 * unchanged.
 */
export const LICH_PREFIX = 'lich-';

/**
 * Infix used when `TEST_RUN_ID` is set. Embedded between `LICH_PREFIX`
 * and the worktree key. The leading `test-` lets tools (and humans) spot
 * a test-owned resource at a glance vs. a real user stack.
 */
export const TEST_RUN_PREFIX = 'test-';

/**
 * Validation for the TEST_RUN_ID env var. Must be safe for use in compose
 * project names, network names, container names, and volume names — same
 * shell-safe character class as the service name validator, plus a length
 * cap to keep total names under docker's 64-char identifier limit (after
 * accounting for `lich-test-<id>-<key>-<service>-data`).
 */
const TEST_RUN_ID_RE = /^[a-z0-9-]{1,20}$/;

const KEY_RE = /^[0-9a-f]{12}$/;
const SERVICE_RE = /^[a-z0-9-]+$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `worktree key must be 12 lowercase hex chars; got ${JSON.stringify(key)}`,
    );
  }
}

function assertService(service: string): void {
  if (!SERVICE_RE.test(service)) {
    throw new Error(
      `service name must match [a-z0-9-]+; got ${JSON.stringify(service)}`,
    );
  }
}

/**
 * Read the active TEST_RUN_ID at call time (not module load). Tests
 * occasionally tweak `process.env.TEST_RUN_ID` between cases to assert
 * the prefix flow; reading per-call keeps that lever working without
 * resetting modules.
 *
 * Returns `null` when unset (production), `string` when set and valid,
 * throws when set but malformed (programmer error — the harness should
 * have validated it before stamping).
 */
function activeTestRunPrefix(): string {
  const raw = process.env.TEST_RUN_ID;
  if (!raw) return '';
  if (!TEST_RUN_ID_RE.test(raw)) {
    throw new Error(
      `TEST_RUN_ID must match [a-z0-9-]{1,20}; got ${JSON.stringify(raw)}`,
    );
  }
  return `${TEST_RUN_PREFIX}${raw}-`;
}

export function containerName(key: string, service: string): string {
  assertKey(key);
  assertService(service);
  return `${LICH_PREFIX}${activeTestRunPrefix()}${key}-${service}`;
}

export function networkName(key: string): string {
  assertKey(key);
  return `${LICH_PREFIX}${activeTestRunPrefix()}${key}`;
}

export function volumeName(key: string, service: string): string {
  assertKey(key);
  assertService(service);
  return `${LICH_PREFIX}${activeTestRunPrefix()}${key}-${service}-data`;
}

export function composeProjectName(key: string): string {
  return networkName(key);
}

/**
 * Returns the active naming prefix (`lich-` or `lich-test-<id>-`).
 * Used by sweepers/cleanup helpers that want to scope `docker ps --filter
 * name=<prefix>` queries to the current test run instead of the global
 * `lich-` namespace (which would catch sibling agents' stacks).
 */
export function activeNamingPrefix(): string {
  return `${LICH_PREFIX}${activeTestRunPrefix()}`;
}
