import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildNodeBinAugmentedPath,
  isPackageManagerExecWrapped,
  scanNodeBinDirs,
} from "../../../src/util/node-bin-path.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "lich-node-bin-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeBinShim(dir: string, tool: string): Promise<void> {
  const binDir = join(dir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function makePackageJson(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"x","version":"0.0.0"}\n');
}

describe("isPackageManagerExecWrapped", () => {
  it.each([
    "pnpm exec nodemon src/index.ts",
    "yarn run dev",
    "yarn exec tsx index.ts",
    "npm exec next dev",
    "npm run dev",
    "npx tsc --watch",
    "bunx vite",
    "bun x vitest",
    "bun run dev",
    "pnpm dlx some-tool",
    "yarn dlx other-tool",
  ])("returns true for %j", (cmd) => {
    expect(isPackageManagerExecWrapped(cmd)).toBe(true);
  });

  it("tolerates leading whitespace before the wrapper", () => {
    expect(isPackageManagerExecWrapped("   pnpm exec nodemon")).toBe(true);
  });

  it("returns false for a bare CLI invocation", () => {
    expect(isPackageManagerExecWrapped("nodemon src/index.ts")).toBe(false);
    expect(isPackageManagerExecWrapped("tsx index.ts")).toBe(false);
    expect(isPackageManagerExecWrapped("./scripts/dev.sh")).toBe(false);
  });

  it("does not false-match commands whose names START with a pm prefix", () => {
    expect(isPackageManagerExecWrapped("npx-clone foo")).toBe(false);
    expect(isPackageManagerExecWrapped("pnpm-helper")).toBe(false);
    expect(isPackageManagerExecWrapped("bunch-of-things")).toBe(false);
  });

  it("does not match pm subcommands that aren't exec-equivalent", () => {
    expect(isPackageManagerExecWrapped("pnpm install")).toBe(false);
    expect(isPackageManagerExecWrapped("npm install")).toBe(false);
    expect(isPackageManagerExecWrapped("yarn install")).toBe(false);
  });
});

describe("scanNodeBinDirs", () => {
  it("does not falsely list a non-existent bin dir for a fresh empty tmpdir", async () => {
    const result = scanNodeBinDirs(workDir);
    expect(result.binDirs).not.toContain(join(workDir, "node_modules", ".bin"));
  });

  it("finds a single bin dir at the cwd", async () => {
    await makePackageJson(workDir);
    await makeBinShim(workDir, "nodemon");
    const result = scanNodeBinDirs(workDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.binDirs[0]).toBe(join(workDir, "node_modules", ".bin"));
  });

  it("walks up the tree and collects both per-workspace and root bin dirs, closest-first", async () => {
    // monorepo shape: <work>/package.json + <work>/apps/api/package.json
    const apiDir = join(workDir, "apps", "api");
    await makePackageJson(workDir);
    await makePackageJson(apiDir);
    await makeBinShim(workDir, "tsx");
    await makeBinShim(apiDir, "nodemon");

    const result = scanNodeBinDirs(apiDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.binDirs[0]).toBe(join(apiDir, "node_modules", ".bin"));
    expect(result.binDirs).toContain(join(workDir, "node_modules", ".bin"));
    const idxClose = result.binDirs.indexOf(join(apiDir, "node_modules", ".bin"));
    const idxRoot = result.binDirs.indexOf(join(workDir, "node_modules", ".bin"));
    expect(idxClose).toBeLessThan(idxRoot);
  });

  it("detects hasPackageJson when only the root has package.json (workspace without its own)", async () => {
    const apiDir = join(workDir, "apps", "api");
    await mkdir(apiDir, { recursive: true });
    await makePackageJson(workDir);
    await makeBinShim(workDir, "vite");

    const result = scanNodeBinDirs(apiDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.binDirs).toContain(join(workDir, "node_modules", ".bin"));
  });

  it("does NOT add bin dirs that exist as paths but aren't actually present", async () => {
    await makePackageJson(workDir);
    const result = scanNodeBinDirs(workDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.binDirs).toEqual([]);
  });
});

describe("buildNodeBinAugmentedPath", () => {
  it("returns null when cmd starts with `pnpm exec` (avoid double-wrap)", async () => {
    await makePackageJson(workDir);
    await makeBinShim(workDir, "nodemon");
    const result = buildNodeBinAugmentedPath(
      workDir,
      "pnpm exec nodemon src/index.ts",
      "/usr/bin",
    );
    expect(result).toBeNull();
  });

  it.each([
    ["yarn run dev"],
    ["npm exec foo"],
    ["npx bar"],
    ["bunx baz"],
    ["bun run start"],
  ])("returns null for already-wrapped cmd %j", async (cmd) => {
    await makePackageJson(workDir);
    await makeBinShim(workDir, "nodemon");
    expect(buildNodeBinAugmentedPath(workDir, cmd, "/usr/bin")).toBeNull();
  });

  it("prepends the cwd's bin dir to an existing PATH", async () => {
    await makePackageJson(workDir);
    await makeBinShim(workDir, "nodemon");
    const result = buildNodeBinAugmentedPath(
      workDir,
      "nodemon src/index.ts",
      "/usr/bin:/bin",
    );
    expect(result).not.toBeNull();
    const expectedBin = join(workDir, "node_modules", ".bin");
    expect(result!.startsWith(expectedBin + delimiter)).toBe(true);
    expect(result!.endsWith("/usr/bin:/bin")).toBe(true);
  });

  it("monorepo: prepends BOTH the per-workspace bin AND the root bin, closest first", async () => {
    const apiDir = join(workDir, "apps", "api");
    await makePackageJson(workDir);
    await makePackageJson(apiDir);
    await makeBinShim(workDir, "tsx");
    await makeBinShim(apiDir, "nodemon");

    const result = buildNodeBinAugmentedPath(
      apiDir,
      "nodemon src/index.ts",
      "/usr/bin",
    );
    expect(result).not.toBeNull();
    const closeBin = join(apiDir, "node_modules", ".bin");
    const rootBin = join(workDir, "node_modules", ".bin");
    expect(result!).toContain(closeBin);
    expect(result!).toContain(rootBin);
    expect(result!.indexOf(closeBin)).toBeLessThan(result!.indexOf(rootBin));
    expect(result!.endsWith("/usr/bin")).toBe(true);
  });

  it("handles an undefined existing PATH by using just the bin prefix", async () => {
    await makePackageJson(workDir);
    await makeBinShim(workDir, "nodemon");
    const result = buildNodeBinAugmentedPath(
      workDir,
      "nodemon src/index.ts",
      undefined,
    );
    expect(result).toBe(join(workDir, "node_modules", ".bin"));
  });

  it("returns null when package.json exists but no node_modules/.bin anywhere", async () => {
    await makePackageJson(workDir);
    const result = buildNodeBinAugmentedPath(
      workDir,
      "nodemon src/index.ts",
      "/usr/bin",
    );
    expect(result).toBeNull();
  });
});
