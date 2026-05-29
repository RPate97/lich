import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURES_DIR } from "./paths.js";

/**
 * Copy a stack fixture to a fresh tmpdir. Returns `{ path, cleanup }`.
 * `prefix` overrides the default `lich-e2e-<fixtureName>-` (used when the
 * derived worktree name needs to be controlled). `install: true` runs
 * `bun install` in the tmpdir (needed for stacks whose owned services rely
 * on locally-installed binaries like `next`).
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
    filter: (src) => !/\/(node_modules|\.next|dist|\.lich|\.tmp)(\/|$)/.test(src),
  });

  if (opts.install) {
    const result = spawnSync("bun", ["install"], {
      cwd: tmp,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
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

/** @deprecated Use {@link copyFixtureToTmpdir}. */
export const copyExampleToTmpdir = copyFixtureToTmpdir;
