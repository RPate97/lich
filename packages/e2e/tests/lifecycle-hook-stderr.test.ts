import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import {
  LICH_BINARY as lichBinary,
  REPO_ROOT as repoRoot,
} from "@/helpers/paths.js";

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

describe("lifecycle hook stderr surfacing", () => {
  it(
    "before_up hook with `|| true` swallowing exit: stderr surfaces inline AND lands in the per-hook log file",
    () => {
      const dir = mkdtempSync(
        join(tmpdir(), "lich-e2e-hook-stderr-up-"),
      );
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-hook-stderr-up-home-"),
      );

      // Subshell ( ... ) required: { ...; exit 1; } exits the whole shell
      // before `||` can mask. Subshell exit is what `||` reads.
      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_up:
    - "( echo 'oops something broke' 1>&2; exit 1 ) || true"
`;

      try {
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

        // `|| true` makes the hook exit 0 → whole up succeeds
        expect(upResult.exitCode).toBe(0);

        // pretty renderer writes to stdout; some modes use stderr — either is fine
        const combined = upResult.stdout + upResult.stderr;
        expect(
          combined,
          `expected "oops" to appear inline in lich up output; ` +
            `stdout=${JSON.stringify(upResult.stdout.slice(-500))}; ` +
            `stderr=${JSON.stringify(upResult.stderr.slice(-500))}`,
        ).toContain("oops something broke");

        const stacksDir = join(home, "stacks");
        expect(existsSync(stacksDir)).toBe(true);
        const stackIds = readdirSync(stacksDir);
        expect(
          stackIds,
          `expected exactly one stack dir under ${stacksDir}; ` +
            `got: ${JSON.stringify(stackIds)}`,
        ).toHaveLength(1);
        const stackId = stackIds[0]!;

        const hookLogPath = join(
          stacksDir,
          stackId,
          "hooks",
          "before_up-0.log",
        );
        expect(
          existsSync(hookLogPath),
          `expected per-hook log file at ${hookLogPath}`,
        ).toBe(true);

        const logContents = readFileSync(hookLogPath, "utf8");
        expect(logContents).toContain("oops something broke");
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

  it(
    "before_down hook with `|| true` swallowing exit: stderr surfaces inline AND lands in the per-hook log file",
    () => {
      const dir = mkdtempSync(
        join(tmpdir(), "lich-e2e-hook-stderr-down-"),
      );
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-hook-stderr-down-home-"),
      );

      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "( echo 'down-time stderr' 1>&2; exit 1 ) || true"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        expect(upResult.exitCode).toBe(0);

        const downResult = runLich(["down"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 30_000,
        });
        if (downResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich down stdout:\n" + downResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich down stderr:\n" + downResult.stderr);
        }
        expect(downResult.exitCode).toBe(0);

        const combined = downResult.stdout + downResult.stderr;
        expect(
          combined,
          `expected "down-time stderr" to appear inline in lich down ` +
            `output; stdout=${JSON.stringify(downResult.stdout.slice(-500))}; ` +
            `stderr=${JSON.stringify(downResult.stderr.slice(-500))}`,
        ).toContain("down-time stderr");

        const stacksDir = join(home, "stacks");
        const stackIds = readdirSync(stacksDir);
        expect(stackIds).toHaveLength(1);
        const stackId = stackIds[0]!;
        const hookLogPath = join(
          stacksDir,
          stackId,
          "hooks",
          "before_down-0.log",
        );
        expect(existsSync(hookLogPath)).toBe(true);
        expect(readFileSync(hookLogPath, "utf8")).toContain("down-time stderr");
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
