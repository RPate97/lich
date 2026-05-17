/**
 * Naming helpers for levelzero compose projects.
 *
 * These produce the stable names that compose, the registry, and operators
 * see — `levelzero-<key>` for the project/network, `levelzero-<key>-<service>`
 * for containers, and `levelzero-<key>-<service>-data` for named volumes.
 *
 * Validation guards (`assertKey`, `assertService`) reject inputs that would
 * produce ambiguous or shell-unsafe names; callers should treat throws here
 * as programmer errors, not user input issues.
 *
 * Previously lived at `src/docker/naming.ts` — moved here as part of LEV-134
 * when the legacy docker runner was deleted.
 */
export const LEVELZERO_PREFIX = 'levelzero-';

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

export function containerName(key: string, service: string): string {
  assertKey(key);
  assertService(service);
  return `${LEVELZERO_PREFIX}${key}-${service}`;
}

export function networkName(key: string): string {
  assertKey(key);
  return `${LEVELZERO_PREFIX}${key}`;
}

export function volumeName(key: string, service: string): string {
  assertKey(key);
  assertService(service);
  return `${LEVELZERO_PREFIX}${key}-${service}-data`;
}

export function composeProjectName(key: string): string {
  return networkName(key);
}
