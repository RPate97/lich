import { beforeAll, describe, expect, it } from "vitest";
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

// Top-level env_from appends one line to $ENV_FROM_COUNTER each time it runs,
// and emits SHARED=top as its dotenv output. Three owned services, no
// depends_on, so all three resolve env in the same startup wave. If the
// resolver re-ran top-level env_from per service the counter would read 4
// (1 top-level + 3 services); the fix resolves it once for the whole `up`.
const FIXTURE_YAML = `version: "1"
env_from:
  - 'echo ran >> "$ENV_FROM_COUNTER"; echo "SHARED=top"'
owned:
  api:
    cmd: |
      echo "API_SHARED=\${SHARED}"
      echo "READY_MARKER"
      sleep 99999
    ready_when:
      log_match: "READY_MARKER"
  web:
    cmd: |
      echo "READY_MARKER"
      sleep 99999
    ready_when:
      log_match: "READY_MARKER"
  worker:
    cmd: |
      echo "READY_MARKER"
      sleep 99999
    ready_when:
      log_match: "READY_MARKER"
`;

describe("top-level env_from resolves once per up", () => {
  it(
    "runs a top-level env_from command exactly once across all services",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-once-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-env-from-once-home-"));
      const counter = join(home, "env_from_runs.log");

      try {
        writeFileSync(join(dir, "lich.yaml"), FIXTURE_YAML, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home, ENV_FROM_COUNTER: counter },
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

        const runs = existsSync(counter)
          ? readFileSync(counter, "utf8")
              .split("\n")
              .filter((l) => l.trim().length > 0).length
          : 0;
        expect(
          runs,
          "top-level env_from should resolve once for the whole up, not once per service",
        ).toBe(1);

        // The single resolution still populates the env every service sees.
        const apiLogs = runLich(["logs", "api", "--no-follow"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 10_000,
        });
        expect(apiLogs.exitCode).toBe(0);
        expect(apiLogs.stdout).toContain("API_SHARED=top");
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
