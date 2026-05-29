import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
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

// Each service prints markers then sleeps; READY_MARKER is last so by the
// time `lich up` returns, the echo lines have already landed in the log buffer.
const FIXTURE_YAML = `version: "1"
env_from:
  - 'echo "SHARED=top"'
owned:
  api:
    cmd: |
      echo "API_SHARED=\${SHARED}"
      echo "API_API_SECRET=\${API_SECRET}"
      echo "API_WEB_SECRET=\${WEB_SECRET}"
      echo "READY_MARKER"
      sleep 99999
    env_from:
      - 'echo "API_SECRET=api-value"'
    ready_when:
      log_match: "READY_MARKER"
  web:
    cmd: |
      echo "WEB_SHARED=\${SHARED}"
      echo "WEB_API_SECRET=\${API_SECRET}"
      echo "WEB_WEB_SECRET=\${WEB_SECRET}"
      echo "READY_MARKER"
      sleep 99999
    env_from:
      - 'echo "WEB_SECRET=web-value"'
      - 'echo "SHARED=web-override"'
    ready_when:
      log_match: "READY_MARKER"
`;

describe("per-service env_from on owned services", () => {
  it(
    "service-scoped env_from values reach the targeted service; siblings see only their own + shared top-level",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-scoped-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-scoped-home-"));

      try {
        writeFileSync(join(dir, "lich.yaml"), FIXTURE_YAML, "utf8");

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

        const webLogs = runLich(["logs", "web", "--no-follow"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 10_000,
        });
        expect(webLogs.exitCode).toBe(0);
        expect(webLogs.stdout).toContain("WEB_WEB_SECRET=web-value");
        expect(webLogs.stdout).toContain("WEB_SHARED=web-override");
        // web has no API_SECRET → empty echo; anchored to line start
        expect(webLogs.stdout).toMatch(/^WEB_API_SECRET=$/m);

        // api has no per-service SHARED override → top-level survives
        const apiLogs = runLich(["logs", "api", "--no-follow"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 10_000,
        });
        expect(apiLogs.exitCode).toBe(0);
        expect(apiLogs.stdout).toContain("API_API_SECRET=api-value");
        expect(apiLogs.stdout).toContain("API_SHARED=top");
        expect(apiLogs.stdout).toMatch(/^API_WEB_SECRET=$/m);
      } finally {
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    90_000,
  );
});
