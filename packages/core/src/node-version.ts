/**
 * LEV-114 — Single source of truth for the minimum Node.js version levelzero
 * supports across the workspace.
 *
 * Why this matters: Vitest 1.6 (and a growing set of our runtime imports — e.g.
 * `node:timers/promises`) requires Node ≥ 18.18, and the project as a whole has
 * settled on Node 20 as the floor. Several subagents and a few human reporters
 * have hit cryptic `ERR_UNKNOWN_BUILTIN_MODULE` errors and silent worker-fetch
 * timeouts when the shell default `node` is 18.x. We'd rather fail fast at the
 * very top of `bin.ts` with a clear, actionable message than let users dig
 * through a 30-line stack trace from deep inside a worker.
 *
 * Treat this constant as the canonical value referenced by:
 *   - Every workspace `package.json#engines.node`
 *   - The startup check called as the FIRST statement of `bin.ts`
 *   - The `doctor` command's node-version check entry
 *
 * Bumping the floor: edit `MIN_NODE_VERSION` here AND every `engines.node` in
 * the repo (a `find packages -name package.json` sweep is the fastest way) AND
 * the scaffolded template's `files/package.json`. The unit tests in
 * `tests/node-version.test.ts` lock the parser shape, not the value, so the
 * value is free to move.
 */
export const MIN_NODE_VERSION = '20.0.0';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a Node.js version string into its semver components. Accepts both the
 * `process.versions.node` form (`"20.20.2"`) and the prefixed form sometimes
 * seen in tooling output (`"v20.20.2"`). Pre-release / build metadata suffixes
 * (`"20.0.0-nightly20230101"`) are tolerated by ignoring everything past the
 * first non-numeric segment of `patch`.
 *
 * Returns `null` rather than throwing so the startup check can keep its error
 * message focused on the version mismatch — a malformed version string from
 * `process.versions.node` would itself be a bug we don't expect to ever hit in
 * practice, but we still want a clean fallback.
 */
export function parseNodeVersion(version: string): ParsedVersion | null {
  // Strip optional leading "v" and any pre-release / build metadata.
  const cleaned = version.replace(/^v/, '').split(/[-+]/, 1)[0] ?? '';
  const parts = cleaned.split('.');
  if (parts.length < 3) return null;
  const [majorStr, minorStr, patchStr] = parts;
  const major = Number.parseInt(majorStr ?? '', 10);
  const minor = Number.parseInt(minorStr ?? '', 10);
  // `patch` can have trailing junk we already stripped above, but be defensive
  // and parseInt anyway — it stops at the first non-digit by design.
  const patch = Number.parseInt(patchStr ?? '', 10);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Returns true iff `actual` is ≥ `required` by lexicographic semver comparison
 * (major → minor → patch). Both inputs are parsed via {@link parseNodeVersion}
 * so the same prefix/suffix tolerance applies. If either string fails to
 * parse, returns `false` — the calling check then surfaces a clear error
 * instead of silently treating a malformed version as "good enough".
 */
export function isNodeVersionAtLeast(actual: string, required: string): boolean {
  const a = parseNodeVersion(actual);
  const r = parseNodeVersion(required);
  if (!a || !r) return false;
  if (a.major !== r.major) return a.major > r.major;
  if (a.minor !== r.minor) return a.minor > r.minor;
  return a.patch >= r.patch;
}

/**
 * Build the user-facing error message we print on a version mismatch. Split
 * out from {@link checkNodeVersion} so tests can assert on the exact shape
 * without mocking `process.exit`. Keep this message:
 *   - Short (one logical sentence, two lines max)
 *   - Self-actionable (tells the user what to do, not just what's wrong)
 *   - Free of stack-trace noise (it's the first thing they see)
 */
export function formatNodeVersionError(
  actualVersion: string,
  requiredVersion: string = MIN_NODE_VERSION,
): string {
  return (
    `levelzero requires Node ${requiredVersion}+; you have ${actualVersion}.\n` +
    `Upgrade Node (e.g. \`nvm install 20 && nvm use 20\`) and re-run the command.`
  );
}

/**
 * Startup gate. Call this as the FIRST executable statement in `bin.ts` —
 * before any other `import` whose side-effects could trip
 * `ERR_UNKNOWN_BUILTIN_MODULE` on an older runtime (the very failure mode this
 * check exists to head off). On a too-old Node, writes a clear single-line
 * error to stderr and exits 1; on a healthy runtime it's a no-op and returns
 * synchronously so the rest of `bin.ts` can proceed unchanged.
 *
 * `processOverride` exists purely for tests — they pass a fake `process`-shaped
 * object so they can assert exit code and stderr without actually killing the
 * test runner. Production callers always pass nothing and get the real
 * `process` from the surrounding scope.
 */
export interface NodeVersionCheckProcess {
  versions: { node: string };
  stderr: { write(s: string): unknown };
  exit(code: number): never;
}

export function checkNodeVersion(
  processOverride?: NodeVersionCheckProcess,
): void {
  const p: NodeVersionCheckProcess =
    processOverride ?? (process as unknown as NodeVersionCheckProcess);
  const actual = p.versions.node;
  if (isNodeVersionAtLeast(actual, MIN_NODE_VERSION)) return;
  p.stderr.write(formatNodeVersionError(actual) + '\n');
  p.exit(1);
}
