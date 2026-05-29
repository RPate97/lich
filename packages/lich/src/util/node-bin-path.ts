/**
 * Auto-prepend `node_modules/.bin` to PATH for owned services so
 * `cmd: nodemon ...` (or any locally-installed CLI) resolves without a
 * `pnpm exec` / `npm run` wrapper. lich's shell-spawn bypasses the
 * package manager's PATH injection.
 *
 * Walk-up doesn't stop at `.git` because monorepos can have
 * `node_modules/.bin` at multiple levels (per-workspace + hoisted root)
 * and npm/pnpm precedence is closest-first.
 *
 * Skipped when (1) cmd is already pm-wrapped or (2) no `package.json`
 * is found anywhere up the tree.
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join, parse } from "node:path";

// Trailing space matters: it stops `npxsomething` from matching, and
// `npx` is unique in that the binary IS the wrapper (no subcommand).
const PM_EXEC_PREFIXES = [
  "pnpm exec ",
  "pnpm dlx ",
  "yarn run ",
  "yarn exec ",
  "yarn dlx ",
  "npm exec ",
  "npm run ",
  "npx ",
  "bunx ",
  "bun x ",
  "bun run ",
];

export function isPackageManagerExecWrapped(cmd: string): boolean {
  const trimmed = cmd.trimStart();
  for (const prefix of PM_EXEC_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

export interface NodeBinScanResult {
  /** Existing `<dir>/node_modules/.bin` paths, closest-first. */
  binDirs: string[];
  /** True if any `package.json` was found at any level of the walk. */
  hasPackageJson: boolean;
}

/**
 * Walk up from `startDir` collecting bin dirs (closest-first) and
 * tracking whether any `package.json` was seen. The two pieces of
 * info are independent — a monorepo can have either at any level.
 */
export function scanNodeBinDirs(startDir: string): NodeBinScanResult {
  const binDirs: string[] = [];
  let hasPackageJson = false;

  const { root } = parse(startDir);
  let current = startDir;

  // Depth cap is paranoia against symlink loops; real repos never come close.
  const MAX_DEPTH = 64;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (existsSync(join(current, "package.json"))) {
      hasPackageJson = true;
    }
    const binDir = join(current, "node_modules", ".bin");
    if (existsSync(binDir)) {
      binDirs.push(binDir);
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { binDirs, hasPackageJson };
}

/**
 * Return PATH with node bin dirs prepended (closest-first), or `null`
 * when no prepend should happen (pm-wrapped, no package.json, or no
 * bin dirs). `null` preserves the original env when nothing changes.
 */
export function buildNodeBinAugmentedPath(
  cwd: string,
  cmd: string,
  currentPath: string | undefined,
): string | null {
  if (isPackageManagerExecWrapped(cmd)) return null;

  const { binDirs, hasPackageJson } = scanNodeBinDirs(cwd);
  if (!hasPackageJson) return null;
  if (binDirs.length === 0) return null;

  const prefix = binDirs.join(delimiter);
  if (currentPath === undefined || currentPath === "") return prefix;
  return `${prefix}${delimiter}${currentPath}`;
}
