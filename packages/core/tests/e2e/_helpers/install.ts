/**
 * E2E harness — install step.
 *
 * The freshly scaffolded project's `package.json` lists `@levelzero/*`
 * dependencies with semver ranges (`^0.1.0`). Those packages are not yet
 * published to npm (LEV-167 is pending), so a naive `bun install` would
 * fail with ERR_NPM_NOT_FOUND for every workspace package.
 *
 * To make `bun install` succeed end-to-end without cheating (i.e. without
 * symlinking into the monorepo `node_modules`), we walk `packages/*` here
 * and write a bun `overrides` block into the scaffolded `package.json`
 * pointing every `@levelzero/*` dep at the local checkout via `file:`.
 *
 * `file:` installs copy the workspace package's tree into
 * `node_modules/@levelzero/<pkg>/` — they're not symlinks, so each test
 * run gets an isolated copy that won't be polluted by the host's
 * `bun install --frozen` state. That mirrors what an end user with a
 * published package would see.
 *
 * Why not `npm:`-style `workspace:` protocol or `npm pack` tarballs:
 *   - `workspace:` requires the consumer to BE a workspace, which the
 *     scaffolded project isn't (it has its own top-level workspaces).
 *   - `npm pack` tarballs would force us to publish/repack every plugin
 *     on every test run, adding ~30s per run.
 *   - `file:` is the simplest mechanism that produces a real install tree.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_PACKAGES_DIR } from './scaffold';

/**
 * Enumerate every `@levelzero/<name>` workspace package and return a map
 * from package name → absolute path. The package's `name` field (not the
 * directory name) is what's authoritative — e.g. `template-v0-stack/` ships
 * `@levelzero/template-v0-stack`.
 */
export function discoverWorkspacePackages(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(REPO_PACKAGES_DIR)) {
    const dir = join(REPO_PACKAGES_DIR, entry);
    let s;
    try {
      s = statSync(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@levelzero/')) {
        out[pkg.name] = dir;
      }
    } catch {
      // Malformed package.json — skip silently. A real install would barf
      // later anyway, with a much clearer error than we can produce here.
    }
  }
  return out;
}

/**
 * Patch the scaffolded `package.json` so every `@levelzero/*` dep resolves
 * to the local workspace via `file:` overrides. Returns the new overrides
 * object so the caller can assert on it if useful.
 *
 * Also adds `@levelzero/core` as a direct devDependency if it isn't already
 * declared. The template's `package.json` only lists `@levelzero/plugin-*`
 * (treating `core` as a transitive of every plugin), which means after a
 * real install `node_modules/.bin/levelzero` is missing — there's no
 * top-level package contributing the bin. This is the LEV-205 template
 * bug; the harness patches it here so the rest of the dogfood suite can
 * exercise the canonical user invocation (`bun x levelzero <args>` /
 * `bun run levelzero <args>`), and the dogfood suite contains an
 * `it.fails('LEV-205 regression: ...', ...)` test that asserts the bug
 * against a snapshot of the scaffolded `package.json` taken BEFORE this
 * function runs. When LEV-205 lands, drop this auto-patch and drop the
 * `.fails` on the regression test in the same change.
 */
export function applyWorkspaceOverrides(projectDir: string): Record<string, string> {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const workspaces = discoverWorkspacePackages();
  const overrides: Record<string, string> = { ...(pkg.overrides ?? {}) };
  for (const [name, dir] of Object.entries(workspaces)) {
    overrides[name] = `file:${dir}`;
  }
  pkg.overrides = overrides;

  // Ensure `@levelzero/core` is a direct dep so the `levelzero` bin lands
  // in `node_modules/.bin/`. Without this, `bun run levelzero` can't find
  // the script even though every plugin transitively depends on core. See
  // the JSDoc above for the followup tracking.
  pkg.devDependencies = pkg.devDependencies ?? {};
  if (!pkg.dependencies?.['@levelzero/core'] && !pkg.devDependencies['@levelzero/core']) {
    pkg.devDependencies['@levelzero/core'] = '*';
    // Overrides still steer the resolution to the local file: path.
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return overrides;
}

export interface InstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `bun install` in the scaffolded project. Patches workspace overrides
 * first, then asserts the install succeeded and that the expected workspace
 * binaries / packages actually landed under `apps/*\/node_modules`.
 *
 * Throws on failure — the suite cannot make progress past `installDeps` if
 * the tree isn't ready, so we'd rather fail loudly in `beforeAll` than let
 * downstream tests time out waiting for missing binaries.
 */
export async function installDeps(projectDir: string): Promise<InstallResult> {
  applyWorkspaceOverrides(projectDir);

  const r = spawnSync('bun', ['install'], {
    cwd: projectDir,
    encoding: 'utf8',
    // `bun install` writes to /dev/tty on success; capture both streams to
    // surface failures in the thrown error.
    stdio: 'pipe',
    // Give bun room to fetch from the network if a transitive isn't cached
    // locally. 5 minutes is the largest possible wait we'd expect on a cold
    // CI runner; in practice this completes in 30-60s once the bun cache is
    // warm.
    timeout: 5 * 60 * 1000,
    env: {
      ...process.env,
      // Don't let stale lockfiles from an earlier scaffold copy interfere.
      // The scaffold step doesn't ship a `bun.lock`, so this is defensive.
    },
  });

  const result: InstallResult = {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };

  if (result.exitCode !== 0) {
    throw new Error(
      `bun install failed in ${projectDir} (exit ${result.exitCode}):\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    );
  }

  // Post-install sanity: assert the binaries / packages the test suite
  // reaches for actually landed. Empirically, bun's `file:` install in this
  // scaffold hoists EVERYTHING to the root `node_modules` — `apps/*/
  // node_modules/` directories are not created at all (verified by a real
  // install probe; see LEV-198 review notes). Pin the assertions to the
  // hoisted root path so a future change in bun's strategy (per-app
  // duplication, nohoist, etc.) fails loudly rather than silently passing.
  const nextBin = join(projectDir, 'node_modules', '.bin', 'next');
  if (!existsSync(nextBin)) {
    throw new Error(
      `bun install completed but ${nextBin} does not exist (expected ` +
        `next to be hoisted to the root node_modules)`,
    );
  }
  // `@prisma/client` is a transitive of `@levelzero/plugin-prisma` and
  // lands at the root after bun hoists.
  const prismaClient = join(projectDir, 'node_modules', '@prisma', 'client');
  if (!existsSync(prismaClient)) {
    throw new Error(
      `bun install completed but ${prismaClient} does not exist (expected ` +
        `@prisma/client to be hoisted to the root node_modules)`,
    );
  }

  return result;
}
