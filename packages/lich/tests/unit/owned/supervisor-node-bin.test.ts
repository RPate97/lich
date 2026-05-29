import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureStackDir,
  serviceLogPath,
} from "../../../src/state/directory.js";
import { startOwnedService } from "../../../src/owned/supervisor.js";

const STACK_ID = "test-stack-node-bin";

let homeDir: string;
let workDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "lich-owned-bin-home-"));
  workDir = await mkdtemp(join(tmpdir(), "lich-owned-bin-work-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  await ensureStackDir(STACK_ID);
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

async function readLog(name: string): Promise<string> {
  const path = serviceLogPath(STACK_ID, name);
  for (let i = 0; i < 20; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return await readFile(path, "utf8");
}

/**
 * Create a `<dir>/node_modules/.bin/<tool>` shim that, when executed,
 * prints a marker line containing the dir it lives in. This lets the
 * test prove WHICH bin dir's shim was found by reading the log.
 */
async function makeShim(dir: string, tool: string): Promise<void> {
  const binDir = join(dir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, tool);
  await writeFile(
    shimPath,
    `#!/bin/sh\necho "shim:${shimPath}"\n`,
    { mode: 0o755 },
  );
}

async function makePackageJson(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"x","version":"0.0.0"}\n');
}

describe("supervisor — node_modules/.bin auto-prepend (LEV-498)", () => {
  it("finds a locally-installed CLI in cwd/node_modules/.bin without pnpm exec wrapping", async () => {
    // The papercut: a user writes `cmd: my-cli` and the CLI lives in
    // <cwd>/node_modules/.bin/my-cli. Without the fix, `spawn /bin/sh -c
    // 'my-cli'` returns exit 127. With the fix, the shim's marker line
    // shows up in the log.
    await makePackageJson(workDir);
    await makeShim(workDir, "my-cli");

    const name = "uses-local-cli";
    const handle = await startOwnedService({
      name,
      cmd: "my-cli",
      cwd: workDir,
      env: { PATH: "/usr/bin:/bin" }, // minimal: no .bin already injected
      logPath: serviceLogPath(STACK_ID, name),
    });

    const result = await handle.exited;
    expect(result.code).toBe(0);

    const log = await readLog(name);
    const expectedShim = join(workDir, "node_modules", ".bin", "my-cli");
    expect(log).toContain(`shim:${expectedShim}`);
  });

  it("monorepo: closest workspace bin wins over root bin (closest-first precedence)", async () => {
    // Materialize a two-level workspace where BOTH levels have a shim
    // named `my-cli`. The supervisor must pick the closer one — that's
    // the universal node convention (`npm`/`pnpm` per-package
    // node_modules/.bin shadows the hoisted one).
    const apiDir = join(workDir, "apps", "api");
    await makePackageJson(workDir);
    await makePackageJson(apiDir);
    await makeShim(workDir, "my-cli");
    await makeShim(apiDir, "my-cli");

    const name = "monorepo-closest-wins";
    const handle = await startOwnedService({
      name,
      cmd: "my-cli",
      cwd: apiDir,
      env: { PATH: "/usr/bin:/bin" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    // The CLOSEST shim must have run, not the root one.
    const closeShim = join(apiDir, "node_modules", ".bin", "my-cli");
    const rootShim = join(workDir, "node_modules", ".bin", "my-cli");
    expect(log).toContain(`shim:${closeShim}`);
    expect(log).not.toContain(`shim:${rootShim}`);
  });

  it("monorepo: BOTH workspace and root bin dirs are on PATH (root shim accessible if workspace bin lacks it)", async () => {
    // Variant of the above: only the ROOT has the shim; the per-workspace
    // bin dir exists (so the walk-up's first hit is real) but doesn't
    // contain `my-cli`. The cmd must still resolve, via the root bin dir
    // — proving the supervisor prepended BOTH, not just the closest.
    const apiDir = join(workDir, "apps", "api");
    await makePackageJson(workDir);
    await makePackageJson(apiDir);
    // Per-workspace bin exists but has a DIFFERENT tool.
    await makeShim(apiDir, "some-other-tool");
    // Root bin has the tool the cmd wants.
    await makeShim(workDir, "my-cli");

    const name = "monorepo-root-fallback";
    const handle = await startOwnedService({
      name,
      cmd: "my-cli",
      cwd: apiDir,
      env: { PATH: "/usr/bin:/bin" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    const result = await handle.exited;
    expect(result.code).toBe(0);

    const log = await readLog(name);
    const rootShim = join(workDir, "node_modules", ".bin", "my-cli");
    expect(log).toContain(`shim:${rootShim}`);
  });

  it("does NOT auto-prepend when cwd is outside any node workspace", async () => {
    // workDir has no package.json. The shim exists at the right path
    // shape but should not be reachable because the auto-prepend
    // bails out for non-node projects.
    //
    // We can't directly assert "PATH was not modified" without reaching
    // into the supervisor; instead we observe behavior: a direct
    // invocation of `my-cli` should exit non-zero (127 = command not
    // found) because the bin dir was never added to PATH.
    await makeShim(workDir, "my-cli");
    // NOTE: deliberately no package.json — so the auto-prepend skips.

    const name = "no-node-context";
    const handle = await startOwnedService({
      name,
      // Run the cmd inside a tightly controlled PATH so the OS doesn't
      // satisfy it from /usr/local/bin etc.
      cmd: "my-cli; echo exit=$?",
      cwd: workDir,
      env: { PATH: "/usr/bin:/bin" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    // sh reports exit 127 for missing commands. We assert on the exit
    // code rather than stderr text since the message varies across
    // bash/dash/zsh.
    expect(log).toContain("exit=127");
  });

  it("does NOT auto-prepend (or double-wrap) when cmd already starts with `pnpm exec`", async () => {
    // The user explicitly wrapped in pnpm exec — the supervisor must
    // respect that choice and not also prepend. Without an actual pnpm
    // binary installed, `pnpm exec ...` will itself fail (sh: pnpm: not
    // found, exit 127). The assertion is that pnpm's failure is what we
    // see — not that the shim ran via auto-prepend.
    await makePackageJson(workDir);
    await makeShim(workDir, "my-cli");

    const name = "already-pm-wrapped";
    const handle = await startOwnedService({
      name,
      cmd: "pnpm exec my-cli; echo exit=$?",
      cwd: workDir,
      // Bare PATH — no pnpm available anywhere.
      env: { PATH: "/usr/bin:/bin" },
      logPath: serviceLogPath(STACK_ID, name),
    });

    await handle.exited;
    const log = await readLog(name);
    // The shim's marker MUST NOT appear: if it had, the supervisor
    // would have double-wrapped, defeating the user's explicit choice.
    const shimPath = join(workDir, "node_modules", ".bin", "my-cli");
    expect(log).not.toContain(`shim:${shimPath}`);
    // pnpm itself was missing → exit 127.
    expect(log).toContain("exit=127");
  });
});
