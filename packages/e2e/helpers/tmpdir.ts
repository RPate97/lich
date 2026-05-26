import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURES_DIR } from "./paths.js";

/**
 * Copy a stack fixture (from `packages/e2e/fixtures/<name>/`) to a fresh
 * tmpdir so e2e tests can mutate it without affecting the source.
 *
 * Returns the tmpdir path and a cleanup function. The fixture's path is
 * resolved via `FIXTURES_DIR` from `helpers/paths.ts`, so callers don't
 * need to know where fixtures live on disk.
 *
 * The optional `prefix` overrides the default `lich-e2e-<fixtureName>-`
 * prefix passed to `mkdtempSync`. Callers use this when the worktree
 * name (derived from the tmpdir basename by lich) needs to be
 * controlled — e.g. the parallel-stacks sentinel wants two copies named
 * distinctly so the two stacks get visibly different `stack_id`s.
 *
 * The optional `install` flag (default false) runs `bun install` in the
 * tmpdir after the copy completes. Required for stacks whose owned
 * services depend on locally-installed binaries (e.g. dogfood-stack's
 * `apps/web` runs `next dev`, which needs `next` in `node_modules/.bin`).
 * Default stays opt-in so cheap tests (validate-only, config parsing)
 * don't pay the install cost. Throws with captured stderr if install
 * exits non-zero.
 */
export function copyFixtureToTmpdir(
  fixtureName: string,
  opts: { prefix?: string; install?: boolean } = {},
): {
  path: string;
  cleanup: () => void;
} {
  const sourcePath = join(FIXTURES_DIR, fixtureName);
  const prefix = opts.prefix ?? `lich-e2e-${fixtureName}-`;
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cpSync(sourcePath, tmp, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules, .next, etc. — they're not needed and slow to copy
      return !/\/(node_modules|\.next|dist|\.lich|\.tmp)(\/|$)/.test(src);
    },
  });

  if (opts.install) {
    const result = spawnSync("bun", ["install"], {
      cwd: tmp,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // Clean up the tmpdir before throwing so failures don't leak space.
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw new Error(
        `bun install failed in ${tmp} (exit ${result.status})\n` +
          `--- stdout ---\n${result.stdout ?? ""}\n` +
          `--- stderr ---\n${result.stderr ?? ""}`,
      );
    }
  }

  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true });
  };

  return { path: tmp, cleanup };
}

/**
 * Back-compat alias. The function used to be called `copyExampleToTmpdir`
 * back when fixtures lived under `<repo>/examples/`. Kept exported so
 * external callers (if any) don't break; new code should use
 * `copyFixtureToTmpdir` directly.
 *
 * @deprecated Use {@link copyFixtureToTmpdir}.
 */
export const copyExampleToTmpdir = copyFixtureToTmpdir;
