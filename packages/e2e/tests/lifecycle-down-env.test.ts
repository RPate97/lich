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

describe("lifecycle before_down + after_down env propagation", () => {
  it(
    "top-level env: reaches before_down and after_down; null entries are unset",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-down-env-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-down-env-home-"));

      const beforeMarker = join(dir, "before-down.marker");
      const afterMarker = join(dir, "after-down.marker");
      const unsetMarker = join(dir, "unset.marker");

      // `${VAR:-fallback}` only fires if VAR is truly unset; set-to-empty
      // would not trigger fallback. Use this to distinguish null-unset from
      // empty-string coercion.
      const yaml = `version: "1"
env:
  CANARY: "from-top-level"
  CANARY_UNSET: null
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  before_down:
    - "printf 'CANARY=%s' \\"$CANARY\\" > ${beforeMarker}"
  after_down:
    - "printf 'CANARY=%s' \\"$CANARY\\" > ${afterMarker}"
    - "printf 'CANARY_UNSET=%s' \\"\${CANARY_UNSET:-fallback}\\" > ${unsetMarker}"
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
        expect(
          upResult.exitCode,
          `lich up should succeed; stderr was:\n${upResult.stderr}`,
        ).toBe(0);

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

        expect(
          existsSync(beforeMarker),
          `expected before_down marker at ${beforeMarker}`,
        ).toBe(true);
        const beforeContent = readFileSync(beforeMarker, "utf8");
        expect(
          beforeContent,
          `before_down should see top-level env CANARY=from-top-level. ` +
            `Actual content: ${JSON.stringify(beforeContent)}`,
        ).toBe("CANARY=from-top-level");

        expect(
          existsSync(afterMarker),
          `expected after_down marker at ${afterMarker}`,
        ).toBe(true);
        const afterContent = readFileSync(afterMarker, "utf8");
        expect(
          afterContent,
          `after_down should see top-level env CANARY=from-top-level. ` +
            `Actual content: ${JSON.stringify(afterContent)}`,
        ).toBe("CANARY=from-top-level");

        expect(existsSync(unsetMarker)).toBe(true);
        const unsetContent = readFileSync(unsetMarker, "utf8");
        expect(
          unsetContent,
          `null-unset should remove CANARY_UNSET from the env entirely, ` +
            `so \${CANARY_UNSET:-fallback} resolves to "fallback". ` +
            `Actual content: ${JSON.stringify(unsetContent)}`,
        ).toBe("CANARY_UNSET=fallback");
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
