import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Two independent chains that DEADLOCK under the old topological-wave scheduler
// but succeed under the graph scheduler:
//   chain B:  b1 (instant) -> b2 (touches $COORD/b2.start on start)
//   chain A:  a1 (ready ONLY after b2.start exists) -> a2 (instant)
//
// Wave scheduler levels: wave0 = {a1, b1}, wave1 = {a2, b2}. The wave barrier
// means b2 can't START until wave0 is fully ready — but a1 (in wave0) only
// becomes ready after b2 has started. So a1 times out → up fails. (a1's
// readiness depends on a service in a LATER wave: the classic cross-chain
// barrier deadlock.)
//
// Graph scheduler: b1 readies instantly → b2 starts (its only dep is ready) and
// touches the marker → a1 (no deps) sees the marker → readies → a2 readies.
// Everything reaches ready and `lich up` exits 0.
const FIXTURE_YAML = `version: "1"
owned:
  b1:
    cmd: 'echo READY_B1; sleep 99999'
    ready_when:
      log_match: READY_B1
  b2:
    depends_on: [b1]
    cmd: 'touch "$COORD/b2.start"; echo READY_B2; sleep 99999'
    ready_when:
      log_match: READY_B2
  a1:
    cmd: 'while [ ! -f "$COORD/b2.start" ]; do sleep 0.05; done; echo READY_A1; sleep 99999'
    ready_when:
      log_match: READY_A1
      timeout: 15s
  a2:
    depends_on: [a1]
    cmd: 'echo READY_A2; sleep 99999'
    ready_when:
      log_match: READY_A2
`;

describe("graph scheduler — independent chain doesn't wait on a sibling chain", () => {
  it(
    "starts a dependent (b2) before an unrelated independent node (a1) is ready",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-graph-chain-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-graph-chain-home-"));
      const coord = mkdtempSync(join(tmpdir(), "lich-e2e-graph-chain-coord-"));

      try {
        writeFileSync(join(dir, "lich.yaml"), FIXTURE_YAML, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home, COORD: coord },
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
          `lich up should succeed under graph scheduling; the old wave ` +
            `scheduler would deadlock a1 (waits for b2) against b2 (waits for ` +
            `wave0, which contains a1). stderr was:\n${upResult.stderr}`,
        ).toBe(0);

        // b2's start marker must exist — proves b2 started (after b1) without
        // waiting for the unrelated a1 to be ready first.
        expect(
          existsSync(join(coord, "b2.start")),
          "b2 never started — its coordination marker is missing",
        ).toBe(true);
      } finally {
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home, COORD: coord },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
        for (const p of [dir, home, coord]) {
          try {
            rmSync(p, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    },
    90_000,
  );
});
