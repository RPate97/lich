import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Copy an example app to a fresh tmpdir so e2e tests can mutate it
 * without affecting the repo's source.
 *
 * Resolves the example path relative to the repo root (REPO_ROOT/examples/<name>).
 * Returns the tmpdir path and a cleanup function.
 */
export function copyExampleToTmpdir(exampleName: string): {
  path: string;
  cleanup: () => void;
} {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const sourcePath = join(repoRoot, "examples", exampleName);

  const tmp = mkdtempSync(join(tmpdir(), `lich-e2e-${exampleName}-`));
  cpSync(sourcePath, tmp, {
    recursive: true,
    filter: (src) => {
      // Skip node_modules, .next, etc. — they're not needed and slow to copy
      return !/\/(node_modules|\.next|dist|\.lich|\.tmp)(\/|$)/.test(src);
    },
  });

  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true });
  };

  return { path: tmp, cleanup };
}
