import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
});

interface Fixture {
  dir: string;
  home: string;
}

let fixture: Fixture | null = null;

afterEach(() => {
  if (!fixture) return;
  try {
    runLich(["down"], {
      cwd: fixture.dir,
      env: { LICH_HOME: fixture.home },
      timeout: 30_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fixture.dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fixture.home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  fixture = null;
});

describe("LEV-525: published_env / container_port port shape", () => {
  it(
    "accepts the new published_env shape on owned services and injects the env var",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-home-"));
      fixture = { dir, home };

      const portDump = join(dir, "port.dump");

      const yaml = `version: "1"
runtime:
  port_range: [19550, 19600]
owned:
  web:
    cmd: 'printf "%s" "$MY_WEB_PORT" > ${portDump}; echo READY; sleep 60'
    port: { published_env: MY_WEB_PORT }
    ready_when:
      log_match: "READY"
`;

      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const upResult = runLich(["up", "--no-browser"], {
        cwd: dir,
        env: { LICH_HOME: home },
        timeout: 30_000,
      });
      expect(
        upResult.exitCode,
        `lich up failed:\n${upResult.stdout}\n${upResult.stderr}`,
      ).toBe(0);

      expect(existsSync(portDump)).toBe(true);
      const dumped = readFileSync(portDump, "utf8").trim();
      const port = Number(dumped);
      expect(port).toBeGreaterThanOrEqual(19550);
      expect(port).toBeLessThanOrEqual(19600);
    },
    45_000,
  );

  it(
    "rejects the pre-LEV-525 `{ env: PORT }` shape with a rename hint",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-old-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-old-home-"));
      fixture = { dir, home };

      const yaml = `version: "1"
owned:
  web:
    cmd: echo hi
    port: { env: PORT }
`;
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["validate"], {
        cwd: dir,
        env: { LICH_HOME: home },
      });
      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/pre-LEV-525/);
      expect(combined).toContain("published_env");
    },
    10_000,
  );

  it(
    "accepts scalar shorthand `- 5432` in a list-shape compose ports",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-scalar-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-scalar-home-"));
      fixture = { dir, home };

      // validate-only — no real container needed
      const yaml = `version: "1"
services:
  api:
    image: nginx:alpine
    ports:
      - 8080
`;
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["validate"], {
        cwd: dir,
        env: { LICH_HOME: home },
      });
      expect(
        result.exitCode,
        `validate failed:\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
    },
    10_000,
  );

  it(
    "rejects a bare `{ container_port: N }` block with a scalar-shorthand hint",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-bare-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-portshape-bare-home-"));
      fixture = { dir, home };

      const yaml = `version: "1"
services:
  api:
    image: nginx:alpine
    ports:
      - { container_port: 8080 }
`;
      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const result = runLich(["validate"], {
        cwd: dir,
        env: { LICH_HOME: home },
      });
      expect(result.exitCode).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/bare/);
      expect(combined).toMatch(/scalar/);
    },
    10_000,
  );
});
