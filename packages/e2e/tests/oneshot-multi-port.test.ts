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
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
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

describe("LEV-510: multi-port ports: on oneshot services", () => {
  it(
    "allocates all 3 ports for a oneshot+multi-port service and injects env vars into cmd",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-oneshot-mp-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-oneshot-mp-home-"));
      fixture = { dir, home };

      const portsDump = join(dir, "ports.dump");

      // Oneshot service writes its injected port env vars to a dump file;
      // web depends on it and stays alive as the long-running service.
      // Shell quoting: single-quoted YAML strings; $VAR passes through to shell.
      const yaml = `version: "1"
runtime:
  port_range: [19400, 19500]
owned:
  svc:
    cmd: 'printf "api=%s db=%s studio=%s" "$SVC_API_PORT" "$SVC_DB_PORT" "$SVC_STUDIO_PORT" > ${portsDump}'
    oneshot: true
    ports:
      api:    { env: SVC_API_PORT }
      db:     { env: SVC_DB_PORT }
      studio: { env: SVC_STUDIO_PORT }
  web:
    cmd: "echo READY; sleep 60"
    port: { env: PORT }
    depends_on: [svc]
    ready_when:
      log_match: "READY"
`;

      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const upResult = runLich(["up", "--no-browser"], {
        cwd: dir,
        env: { LICH_HOME: home },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:\n" + upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:\n" + upResult.stderr);
      }
      expect(
        upResult.exitCode,
        `lich up should succeed; stderr was:\n${upResult.stderr}`,
      ).toBe(0);

      expect(
        existsSync(portsDump),
        `ports.dump should have been written by the oneshot cmd`,
      ).toBe(true);

      const dumped = readFileSync(portsDump, "utf8").trim();
      const m = dumped.match(/^api=(\d+) db=(\d+) studio=(\d+)$/);
      expect(
        m,
        `ports.dump should match "api=<n> db=<n> studio=<n>"; got: ${dumped}`,
      ).not.toBeNull();

      const [, api, db, studio] = m!;
      expect(Number(api)).toBeGreaterThanOrEqual(19400);
      expect(Number(db)).toBeGreaterThanOrEqual(19400);
      expect(Number(studio)).toBeGreaterThanOrEqual(19400);
      expect(api).not.toBe(db);
      expect(db).not.toBe(studio);
      expect(api).not.toBe(studio);
    },
    90_000,
  );

  it(
    "resolves ${owned.svc.ports.key} in top-level env and after_up hooks for oneshot services",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-oneshot-mp-env-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-oneshot-mp-env-home-"));
      fixture = { dir, home };

      const envDump = join(dir, "env.dump");

      const yaml = `version: "1"
runtime:
  port_range: [19400, 19500]
owned:
  svc:
    cmd: "true"
    oneshot: true
    ports:
      api:    { env: SVC_API_PORT }
      db:     { env: SVC_DB_PORT }
      studio: { env: SVC_STUDIO_PORT }
  web:
    cmd: "echo READY; sleep 60"
    port: { env: PORT }
    depends_on: [svc]
    ready_when:
      log_match: "READY"
env:
  API_URL: "http://localhost:\${owned.svc.ports.api}"
  DB_URL: "postgresql://localhost:\${owned.svc.ports.db}/postgres"
lifecycle:
  after_up:
    - 'printf "api_url=%s db_url=%s" "$API_URL" "$DB_URL" > ${envDump}'
`;

      writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

      const upResult = runLich(["up", "--no-browser"], {
        cwd: dir,
        env: { LICH_HOME: home },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:\n" + upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:\n" + upResult.stderr);
      }
      expect(
        upResult.exitCode,
        `lich up should succeed; stderr was:\n${upResult.stderr}`,
      ).toBe(0);

      expect(
        existsSync(envDump),
        `env.dump should have been written by after_up hook`,
      ).toBe(true);

      const dumped = readFileSync(envDump, "utf8").trim();
      expect(
        dumped,
        `env.dump should contain api_url=http://localhost:<port>; got: ${dumped}`,
      ).toMatch(/api_url=http:\/\/localhost:\d+/);
      expect(
        dumped,
        `env.dump should contain db_url=postgresql://...; got: ${dumped}`,
      ).toMatch(/db_url=postgresql:\/\/localhost:\d+\/postgres/);
    },
    90_000,
  );
});
