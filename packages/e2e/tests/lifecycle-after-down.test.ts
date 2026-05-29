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

describe("lifecycle.after_down hook", () => {
  it(
    "fires AFTER before_down and AFTER service teardown",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-after-down-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-after-down-home-"));

      // Sentinel files the hooks write to. Living under the tmpdir means
      // they go away with the rest of the test debris in teardown. The
      // tmpdir prefix never contains single-quote chars (per mkdtempSync
      // semantics on POSIX) so embedding paths inline in shell single-
      // quoted yaml strings is safe — no shell quoting helper needed.
      const ledger = join(dir, "down.ledger");
      const livenessProbe = join(dir, "svc-was.txt");
      const pidFile = join(dir, "svc.pid");

      // Synthetic single-service stack. `sleep 60` is the owned service —
      // SIGTERM kills it during teardown; the after_down hook checks
      // whether the supervised process is dead by `kill -0`'ing the pid
      // the service wrote on startup. dead = after_down ran AFTER
      // teardown (the contract); alive = ordering broke.
      //
      //   - svc writes its own pid to `svc.pid`, then sleeps.
      //   - before_down + after_down both append to `down.ledger` so
      //     their relative order is observable on disk.
      //   - after_down's second entry reads svc.pid and writes either
      //     "alive" or "dead" to the livenessProbe sentinel.
      //
      // YAML quoting: every cmd uses double-quoted YAML strings so we
      // can embed shell single-quotes verbatim (for shell parameter
      // substitution). Inside double-quoted YAML, "$" must NOT be
      // escaped (lich's interpolation engine only treats "${...}"
      // shapes as interpolation; bare "$$" / "$PID" pass through to
      // the shell). Newlines inside `printf` must be the literal "\n"
      // sequence in the shell argv, so we double-escape in the TS
      // template string ("\\n" → "\n" in the rendered yaml → "\n" the
      // printf builtin expands).
      const yaml = `version: "1"
owned:
  svc:
    cmd: "echo $$ > ${pidFile}; sleep 60"
lifecycle:
  before_down:
    - "printf 'BEFORE\\n' >> ${ledger}"
  after_down:
    - "printf 'AFTER\\n' >> ${ledger}"
    - "PID=$(cat ${pidFile}); if kill -0 \\\"$PID\\\" 2>/dev/null; then printf alive > ${livenessProbe}; else printf dead > ${livenessProbe}; fi"
`;

      try {
        writeFileSync(join(dir, "lich.yaml"), yaml, "utf8");

        // ---- lich up (fast pool — no docker) ----------------------------
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
          existsSync(join(dir, "svc.pid")),
          "expected supervised svc to write its pid to svc.pid",
        ).toBe(true);

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
          existsSync(livenessProbe),
          `expected after_down liveness probe at ${livenessProbe}`,
        ).toBe(true);

        expect(
          existsSync(ledger),
          `expected ledger file at ${ledger}`,
        ).toBe(true);
        const ledgerLines = readFileSync(ledger, "utf8").trim().split("\n");
        expect(ledgerLines).toEqual(["BEFORE", "AFTER"]);

        // "dead" = svc was reaped before after_down ran; "alive" = ordering bug
        const liveness = readFileSync(livenessProbe, "utf8");
        expect(
          liveness,
          `after_down liveness probe should report "dead" (svc fully ` +
            `torn down before after_down ran) — actual value: ${JSON.stringify(liveness)}`,
        ).toBe("dead");
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
    "profile-scoped after_down runs BEFORE top-level after_down (LIFO, mirror of before_down)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-after-down-prof-"));
      const home = mkdtempSync(
        join(tmpdir(), "lich-e2e-after-down-prof-home-"),
      );
      const ledger = join(dir, "after_down.ledger");

      const yaml = `version: "1"
owned:
  svc:
    cmd: "sleep 60"
lifecycle:
  after_down:
    - "printf 'TOP\\n' >> ${ledger}"
profiles:
  dev:fast:
    default: true
    owned: [svc]
    lifecycle:
      after_down:
        - "printf 'PROFILE\\n' >> ${ledger}"
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

        expect(existsSync(ledger)).toBe(true);
        const lines = readFileSync(ledger, "utf8").trim().split("\n");
        // PROFILE first (child undoes specialization), then TOP
        expect(lines).toEqual(["PROFILE", "TOP"]);
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
