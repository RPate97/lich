import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy an example app to a fresh tmpdir so e2e tests can mutate it
 * without affecting the repo's source.
 *
 * Resolves the example path relative to the repo root (REPO_ROOT/examples/<name>).
 * Returns the tmpdir path and a cleanup function.
 *
 * The optional `prefix` overrides the default `lich-e2e-<exampleName>` prefix
 * passed to `mkdtempSync`. Callers use this when the worktree name (derived
 * from the tmpdir basename by lich) needs to be controlled — e.g. the
 * parallel-stacks sentinel wants two copies named distinctly so the two
 * stacks get visibly different `stack_id`s.
 *
 * The optional `install` flag (default false) runs `bun install` in the
 * tmpdir after the copy completes. Required for stacks whose owned services
 * depend on locally-installed binaries (e.g. dogfood-stack's `apps/web` runs
 * `next dev`, which needs `next` in `node_modules/.bin`). The default stays
 * opt-in so cheap tests (validate-only, config parsing) don't pay the
 * install cost. Throws with captured stderr if install exits non-zero.
 */
export function copyExampleToTmpdir(
  exampleName: string,
  opts: { prefix?: string; install?: boolean } = {},
): {
  path: string;
  cleanup: () => void;
} {
  // Portable across Bun (where `import.meta.dir` works) and Node/vitest
  // (which only supports `import.meta.url`). The previous Bun-only form
  // broke when vitest collected this module's tests.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const sourcePath = join(repoRoot, "examples", exampleName);

  const prefix = opts.prefix ?? `lich-e2e-${exampleName}-`;
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
