import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
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
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

afterEach(() => {
  if (!fixture) return;
  try {
    runLich(["nuke", "--yes"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 60_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown lich nuke failed:", err);
  }
  try {
    fixture.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown tmpdir cleanup failed:", err);
  }
  try {
    rmSync(fixture.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("teardown LICH_HOME cleanup failed:", err);
  }
  fixture = null;
});

describe("dogfood-stack owned.api lifecycle.after_ready (LEV-472)", () => {
  it(
    "api after_ready hook fires only after api becomes ready and can reach /health",
    () => {
      const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-after-ready-api-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };
      const warmupPath = join(home, "api-warmup.log");

      // Pre-condition: hook fires only after ready_when, not at copy time.
      expect(
        existsSync(warmupPath),
        `api-warmup.log should not exist before lich up (got ${warmupPath})`,
      ).toBe(false);

      // Default profile (dev:fast) keeps this in the fast pool.
      const upResult = runLich(["up", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:\n" + upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:\n" + upResult.stderr);
      }
      // Primary timing assertion: the hook curls /health with `curl -f`.
      // If after_ready ran before the api was serving, curl -f exits
      // non-zero and `lich up` fails. Exit 0 ⇒ api was serving when the
      // hook fired ⇒ after_ready genuinely fired *after* ready.
      expect(
        upResult.exitCode,
        `lich up should succeed; stderr was:\n${upResult.stderr}`,
      ).toBe(0);

      expect(
        existsSync(warmupPath),
        `expected after_ready marker at ${warmupPath}`,
      ).toBe(true);

      const contents = readFileSync(warmupPath, "utf8");

      // Timestamp line proves the hook ran (didn't just touch the file).
      expect(
        contents,
        `marker should contain an ISO-8601 warmed_at; got:\n${contents}`,
      ).toMatch(/^warmed_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);

      // Captured /health body proves: (a) api was serving when the hook
      // fired, (b) top-level `API_URL` interpolation reached the hook env,
      // (c) dev:fast resolves db:"stub" (no DATABASE_URL).
      expect(
        contents,
        `marker should contain api /health body with db:"stub"; got:\n${contents}`,
      ).toMatch(/^health=\{"status":"ok","db":"stub"\}$/m);
    },
    120_000,
  );
});
