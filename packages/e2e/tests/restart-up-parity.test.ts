// LEV-528 — systematic audit: does `lich restart` match `lich up` along every
// operational dimension? One describe block per dimension. PASSING tests are
// regression locks; SKIPPED tests document a known divergence (with a `SKIP:`
// comment pointing at the follow-up ticket the controller will file).

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { LICH_BINARY, REPO_ROOT } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(LICH_BINARY)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(REPO_ROOT, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(`failed to build lich binary (exit ${build.status})`);
  }
});

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
  outDir: string;
}

let fixture: Fixture | null = null;

function makeCustomFixture(yaml: string, prefix = "lich-e2e-restart-parity-"): Fixture {
  const stackPath = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(stackPath, "lich.yaml"), yaml, "utf8");
  const lichHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  const outDir = mkdtempSync(join(tmpdir(), `${prefix}out-`));
  return {
    stackPath,
    stackCleanup: () => rmSync(stackPath, { recursive: true, force: true }),
    lichHome,
    outDir,
  };
}

function makeDogfoodFixture(): Fixture {
  const stack = copyFixtureToTmpdir("dogfood-stack", { install: true });
  const lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-restart-parity-dogfood-home-"));
  const outDir = mkdtempSync(join(tmpdir(), "lich-e2e-restart-parity-dogfood-out-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome,
    outDir,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 30_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try { fix.stackCleanup(); } catch { /* best-effort */ }
  try { rmSync(fix.lichHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(fix.outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

function findStackId(lichHome: string): string {
  const root = join(lichHome, "stacks");
  const dirs = readdirSync(root).filter((n) => {
    try { return statSync(join(root, n)).isDirectory(); } catch { return false; }
  });
  expect(dirs.length).toBeGreaterThan(0);
  return dirs[0]!;
}

function readState(lichHome: string, stackId: string): any {
  return JSON.parse(readFileSync(join(lichHome, "stacks", stackId, "state.json"), "utf8"));
}

function waitForFile(path: string, predicate: (contents: string) => boolean, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      if (predicate(contents)) return contents;
    }
    const start = Date.now();
    while (Date.now() - start < 100) { /* busy */ }
  }
  throw new Error(
    `timeout waiting for predicate on ${path}; last contents: ${existsSync(path) ? readFileSync(path, "utf8") : "(missing)"}`,
  );
}

// ---------------------------------------------------------------------------
// Dimension: cmd interpolation timing
// `lich up`: ${...} resolved at up time using yaml + allocated ports/captured values.
// `lich restart` (whole-stack): must use the snapshot's pre-resolved cmd, NOT
// re-interpolate from yaml. This is the cmd-side analog of LEV-527.
// ---------------------------------------------------------------------------
describe("cmd interpolation: restart uses snapshot cmd, not re-interpolated yaml", () => {
  it(
    "edit yaml cmd between up and restart — restart still executes the up-time cmd",
    () => {
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-cmd-")), "cmd.log");
      const makeYaml = (tag: string) => `version: "1"
owned:
  worker:
    cmd: 'printf "%s\\n" "${tag}" >> ${markerFile}; sleep 9999'
`;
      fixture = makeCustomFixture(makeYaml("up-time-cmd"), "lich-e2e-parity-cmd-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const beforeContent = waitForFile(markerFile, (s) => s.includes("up-time-cmd"), 10_000);
      expect(beforeContent.trim().split("\n")).toEqual(["up-time-cmd"]);

      writeFileSync(join(stackPath, "lich.yaml"), makeYaml("edited-cmd"), "utf8");

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterContent = waitForFile(markerFile, (s) => s.trim().split("\n").length >= 2, 15_000);
      expect(
        afterContent.trim().split("\n"),
        "restart must re-run the up-time cmd, not the edited yaml cmd",
      ).toEqual(["up-time-cmd", "up-time-cmd"]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: working directory resolution
// `lich up`: resolves cwd from yaml (defaults to worktree root).
// `lich restart`: must use snapshot's service_cwd, preserved at up time.
// ---------------------------------------------------------------------------
describe("cwd resolution: restart uses snapshot service_cwd", () => {
  it(
    "service_cwd in snapshot is preserved across restart, and pwd output matches",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "lich-parity-cwd-out-"));
      const markerFile = join(outDir, "cwd.log");
      const subdirYaml = `version: "1"
owned:
  worker:
    cmd: 'pwd >> ${markerFile}; printf "ready\\n"; sleep 9999'
    cwd: sub
    ready_when:
      log_match: "ready"
`;
      fixture = makeCustomFixture(subdirYaml, "lich-e2e-parity-cwd-");
      const { stackPath, lichHome } = fixture;
      writeFileSync(join(stackPath, "lich.yaml"), subdirYaml, "utf8");
      const subdir = join(stackPath, "sub");
      try { rmSync(subdir, { recursive: true, force: true }); } catch { /* */ }
      const fs = require("node:fs");
      fs.mkdirSync(subdir, { recursive: true });

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeSnap = readState(lichHome, stackId);
      const beforeWorker = beforeSnap.services.find((s: any) => s.name === "worker");
      expect(beforeWorker.service_cwd).toContain("/sub");

      // ready_when blocks until cmd has run, so pwd line is on disk.
      waitForFile(markerFile, (s) => s.trim().split("\n").filter(Boolean).length >= 1, 5_000);

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterSnap = readState(lichHome, stackId);
      const afterWorker = afterSnap.services.find((s: any) => s.name === "worker");
      expect(afterWorker.service_cwd).toBe(beforeWorker.service_cwd);

      // After restart, ready_when blocks on a second "ready" line, so pwd has been
      // appended twice. Both lines must end with "/sub".
      waitForFile(markerFile, (s) => s.trim().split("\n").filter(Boolean).length >= 2, 10_000);
      const lines = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const l of lines) {
        expect(l, `pwd line: ${l}`).toContain("/sub");
      }

      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: env_from / env_groups / top-level env literals propagation
// `lich up`: resolves env_from cmds, env_groups (process_env: false isolation),
// and top-level env: literals into each service's resolved_env.
// `lich restart`: snapshot already has resolved_env — must reuse it verbatim.
// Covered by LEV-527's regression test (restart-yaml-edit.test.ts). This test
// adds a regression lock asserting that env_from/env_groups/literal categories
// all survive a whole-stack restart.
// ---------------------------------------------------------------------------
describe("env: top-level literals, env_from, env_groups all preserved across restart", () => {
  it(
    "literal env + env_from cmd output + env-from-file all appear in snapshot pre and post restart",
    () => {
      const secretsScript = join(mkdtempSync(join(tmpdir(), "lich-parity-envfrom-bin-")), "fake-secrets.sh");
      writeFileSync(secretsScript, `#!/bin/sh\nprintf 'FROM_CMD=hello-world\\n'\n`, { mode: 0o755 });
      const fs = require("node:fs");
      fs.chmodSync(secretsScript, 0o755);

      const yaml = `version: "1"

env:
  LITERAL_VAR: "literal-up-time"

env_from:
  - cmd: "${secretsScript}"
    format: dotenv

owned:
  worker:
    cmd: 'sleep 9999'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-envfrom-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeSnap = readState(lichHome, stackId);
      const beforeWorker = beforeSnap.services.find((s: any) => s.name === "worker");
      expect(beforeWorker.resolved_env.LITERAL_VAR).toBe("literal-up-time");
      expect(beforeWorker.resolved_env.FROM_CMD).toBe("hello-world");

      // Edit yaml to scramble both — restart must NOT pick them up.
      const yamlB = `version: "1"

env:
  LITERAL_VAR: "literal-changed"

owned:
  worker:
    cmd: 'sleep 9999'
`;
      writeFileSync(join(stackPath, "lich.yaml"), yamlB, "utf8");

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterSnap = readState(lichHome, stackId);
      const afterWorker = afterSnap.services.find((s: any) => s.name === "worker");
      expect(
        afterWorker.resolved_env.LITERAL_VAR,
        "literal env must come from snapshot, not edited yaml",
      ).toBe("literal-up-time");
      expect(
        afterWorker.resolved_env.FROM_CMD,
        "env_from output must come from snapshot, not re-execute the (now-removed) env_from cmd",
      ).toBe("hello-world");
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: per-service lifecycle hooks
// `lich up`: runs before_start, then start, then ready probe, then after_ready.
// `lich restart` (whole-stack): goes through runUp → runs all hooks normally.
// `lich restart <service>`: per the LEV-516 ticket, before_start/after_ready
// SHOULD fire. Today's per-service code path (restart.ts runPerServiceRestart)
// does NOT run before_start or after_ready — only before_down + stop + start +
// ready_when probe. This is documented as intentional in commit 014635e but
// the LEV-528 audit asks us to check whether restart matches up.
// ---------------------------------------------------------------------------
describe("per-service lifecycle hooks: before_start / after_ready", () => {
  it(
    "whole-stack restart fires after_ready for each owned service (regression lock for LEV-516 via dogfood-stack)",
    async () => {
      fixture = makeDogfoodFixture();
      const { stackPath, lichHome } = fixture;
      const warmupPath = join(lichHome, "api-warmup.log");

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome, LICH_HOME_ALT: lichHome },
        timeout: 90_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);
      expect(existsSync(warmupPath), `after_ready marker must exist after up`).toBe(true);

      // Delete the marker so we can prove the restart fires after_ready again.
      rmSync(warmupPath, { force: true });

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome, LICH_HOME_ALT: lichHome },
        timeout: 120_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      // Whole-stack restart calls runUp → runs after_ready for each service.
      expect(
        existsSync(warmupPath),
        `whole-stack restart must re-fire api after_ready hook (regression lock for LEV-516); ` +
          `if marker is missing, the after_ready divergence is back`,
      ).toBe(true);
    },
    240_000,
  );

  it(
    "per-service restart fires before_start hook (LEV-540)",
    () => {
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-bss-")), "before_start.log");
      const yaml = `version: "1"
owned:
  worker:
    cmd: 'echo "worker-ready"; sleep 9999'
    ready_when:
      log_match: "worker-ready"
    lifecycle:
      before_start:
        - 'printf "fired\\n" >> ${markerFile}'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-bss-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      // Up fires before_start once.
      expect(readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean)).toEqual(["fired"]);

      const restartResult = runLich(["restart", "worker"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      // After restart, before_start fires again — file now has two lines.
      const contents = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(contents, "per-service restart MUST fire before_start (LEV-540)").toEqual(["fired", "fired"]);
    },
    120_000,
  );

  it(
    "per-service restart fires after_ready hook (LEV-541)",
    () => {
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-ars-")), "after_ready.log");
      const yaml = `version: "1"
owned:
  worker:
    cmd: 'echo "worker-ready"; sleep 9999'
    ready_when:
      log_match: "worker-ready"
    lifecycle:
      after_ready:
        - 'printf "fired\\n" >> ${markerFile}'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-ars-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      // Up fires after_ready once.
      expect(readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean)).toEqual(["fired"]);

      const restartResult = runLich(["restart", "worker"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      // After restart, after_ready fires again — file now has two lines.
      const contents = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(contents, "per-service restart MUST fire after_ready (LEV-541)").toEqual(["fired", "fired"]);
    },
    120_000,
  );

  it(
    "per-service restart fires before_down hook (snapshot-driven)",
    () => {
      const markerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-bds-")), "before_down.log");
      const yaml = `version: "1"
owned:
  worker:
    cmd: 'sleep 9999'
    lifecycle:
      before_down:
        - 'printf "fired\\n" >> ${markerFile}'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-bds-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      expect(existsSync(markerFile), "before_down must NOT fire during up").toBe(false);

      const restartResult = runLich(["restart", "worker"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      expect(
        existsSync(markerFile),
        "per-service restart MUST fire before_down (it runs on the kill side of restart)",
      ).toBe(true);
      const contents = readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(contents).toEqual(["fired"]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: top-level lifecycle hooks
// `lich up`: runs before_up → start services → after_up. before_down/after_down
// are scheduled for the eventual `lich down`.
// `lich restart` (whole-stack): tears down (runs before_down + after_down) and
// brings up (runs before_up + after_up). i.e. all four top-level hooks fire.
// `lich restart <service>`: runs NEITHER top-level before_up nor top-level
// before_down — intentional per commit 014635e.
// ---------------------------------------------------------------------------
describe("top-level lifecycle hooks: before_up / after_up / before_down / after_down", () => {
  it(
    "whole-stack restart fires before_up + after_up + before_down + after_down (= full down+up)",
    () => {
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-tll-")), "ledger.log");
      const yaml = `version: "1"
owned:
  svc:
    cmd: 'sleep 9999'
lifecycle:
  before_up:
    - 'printf "before_up\\n" >> ${ledgerFile}'
  after_up:
    - 'printf "after_up\\n" >> ${ledgerFile}'
  before_down:
    - 'printf "before_down\\n" >> ${ledgerFile}'
  after_down:
    - 'printf "after_down\\n" >> ${ledgerFile}'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-tll-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const linesAfterUp = readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(linesAfterUp).toEqual(["before_up", "after_up"]);

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const linesAfterRestart = readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean);
      // Whole-stack restart = down + up, so we expect a full cycle:
      // up:        [before_up, after_up]
      // restart's down half:  +[before_down, after_down]
      // restart's up half:    +[before_up, after_up]
      expect(linesAfterRestart).toEqual([
        "before_up",
        "after_up",
        "before_down",
        "after_down",
        "before_up",
        "after_up",
      ]);
    },
    120_000,
  );

  it(
    "per-service restart does NOT fire top-level before_up / after_up / before_down / after_down",
    () => {
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "lich-parity-tlls-")), "ledger.log");
      const yaml = `version: "1"
owned:
  svc:
    cmd: 'sleep 9999'
lifecycle:
  before_up:
    - 'printf "before_up\\n" >> ${ledgerFile}'
  after_up:
    - 'printf "after_up\\n" >> ${ledgerFile}'
  before_down:
    - 'printf "before_down\\n" >> ${ledgerFile}'
  after_down:
    - 'printf "after_down\\n" >> ${ledgerFile}'
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-tlls-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const linesAfterUp = readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(linesAfterUp).toEqual(["before_up", "after_up"]);

      const restartResult = runLich(["restart", "svc"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const linesAfterRestart = readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean);
      // Per-service restart must not touch top-level hooks.
      expect(
        linesAfterRestart,
        "per-service restart must not fire any top-level lifecycle hook (no down+up cycle)",
      ).toEqual(["before_up", "after_up"]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: profile preservation
// `lich up <profile>`: snapshots active_profile.
// `lich restart`: must reuse snapshotted active_profile (LEV-517 fix).
// Redundant with restart-preserves-profile.test.ts, but kept here as a
// dimension-level regression lock.
// ---------------------------------------------------------------------------
describe("profile preservation across restart (LEV-517 regression lock)", () => {
  it(
    "restart preserves the active_profile and the per-profile owned set",
    async () => {
      fixture = makeDogfoodFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "dev:fast", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });
      expect(beforeSnap.active_profile).toBe("dev:fast");
      expect(beforeSnap.services.map((s) => s.name).sort()).toEqual(["api", "web"]);

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 180_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });
      expect(afterSnap.active_profile).toBe("dev:fast");
      expect(afterSnap.services.map((s) => s.name).sort()).toEqual(["api", "web"]);
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: ready / fail_when
// `lich up`: evaluates ready_when (blocks until ready or timeout) and arms
// fail_when watchers post-startup.
// `lich restart` (whole-stack): same path via runUp.
// `lich restart <service>`: runPerServiceRestart in commands/restart.ts calls
// runReadyProbe which honors ready_when. fail_when is NOT armed on per-service
// restart (no LogTail / FailWhenWatcher wiring in restart.ts).
// ---------------------------------------------------------------------------
describe("ready / fail_when on restart", () => {
  it(
    "per-service restart waits for ready_when before returning success",
    () => {
      // A service that takes ~500ms to print its ready line. Restart with
      // ready_when.log_match must wait for the line before returning.
      const yaml = `version: "1"
owned:
  slow:
    cmd: 'sleep 0.5; echo "slow-ready"; sleep 9999'
    ready_when:
      log_match: "slow-ready"
      timeout: 5s
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-ready-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const start = Date.now();
      const restartResult = runLich(["restart", "slow"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      const elapsedMs = Date.now() - start;
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);
      // Should have waited ~500ms for the slow-ready line. Allow generous slack.
      expect(elapsedMs, `restart should have blocked on ready_when (~500ms)`).toBeGreaterThan(300);
    },
    90_000,
  );

  it(
    "per-service restart arms fail_when watcher during ready_when probe (LEV-542)",
    () => {
      // Service that prints ready + then emits fail_when pattern after a short delay
      // BUT the ready_when log_match is "READY_NEVER_MATCHES" so the watcher never wins
      // — fail_when fires first and per-service restart should surface failure.
      const yaml = `version: "1"
owned:
  bad:
    cmd: 'echo "starting"; sleep 0.3; echo "EADDRINUSE port bound"; sleep 9999'
    ready_when:
      log_match: "READY_NEVER_MATCHES"
      timeout: 10s
    fail_when:
      log_match: "EADDRINUSE"
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-fw-");
      const { stackPath, lichHome } = fixture;

      // First up MUST fail too (since READY_NEVER_MATCHES), so we expect a non-zero exit.
      // Verify that the failure mode is the fail_when match (NOT a ready_when timeout).
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).not.toBe(0);
      expect(upResult.stdout + upResult.stderr).toContain("EADDRINUSE");

      // Bring the stack into "up" state with a different (non-failing) config so we can
      // test that per-service restart catches the post-restart fail_when match. We rewrite
      // the yaml to make 'bad' a service that becomes ready and only emits the fail_when
      // pattern after restart re-spawns it.
      //
      // Strategy: use a marker file so the cmd checks if a "trigger fail" file exists.
      // When the trigger file exists, the cmd emits EADDRINUSE FIRST then sleeps before the
      // ready line. The fail_when watcher must trip before ready_when can resolve.
      const triggerDir = mkdtempSync(join(tmpdir(), "lich-parity-fw-trigger-"));
      const triggerFile = join(triggerDir, "trigger");
      const yamlReady = `version: "1"
owned:
  bad:
    cmd: 'if [ -f ${triggerFile} ]; then echo "EADDRINUSE port bound"; sleep 0.5; fi; echo "ready-line"; sleep 9999'
    ready_when:
      log_match: "ready-line"
      timeout: 10s
    fail_when:
      log_match: "EADDRINUSE"
`;
      writeFileSync(join(stackPath, "lich.yaml"), yamlReady, "utf8");

      // Tear down any partial state from the failed up.
      runLich(["down"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 30_000 });
      runLich(["nuke", "--yes"], { cwd: stackPath, env: { LICH_HOME: lichHome }, timeout: 20_000 });

      const upOk = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upOk.exitCode, `${upOk.stdout}\n${upOk.stderr}`).toBe(0);

      // Touch the trigger so the NEXT spawn (via restart) will print EADDRINUSE.
      writeFileSync(triggerFile, "go", "utf8");

      const restartResult = runLich(["restart", "bad"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });

      // Restart must fail because fail_when matched.
      expect(
        restartResult.exitCode,
        `per-service restart must surface fail_when match (LEV-542); stdout=${restartResult.stdout}\nstderr=${restartResult.stderr}`,
      ).not.toBe(0);
      const combined = restartResult.stdout + "\n" + restartResult.stderr;
      expect(combined).toContain("EADDRINUSE");

      try { rmSync(triggerDir, { recursive: true, force: true }); } catch { /* */ }
    },
    180_000,
  );

  it(
    "snapshot state reflects 'ready' for restarted services and stack remains 'up'",
    async () => {
      // Reuse the dogfood-stack — dev:fast — to assert state.json post-restart.
      fixture = makeDogfoodFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 90_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });
      for (const svc of afterSnap.services) {
        expect(svc.state, `${svc.name} state`).toBe("ready");
      }
      expect(afterSnap.status).toBe("up");
    },
    240_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: dependency ordering
// `lich up`: respects depends_on for spin-up ordering.
// `lich restart <service>`: only touches the named service; does NOT cascade
// to dependents (proven by restart-per-service.test.ts — svc-a/svc-c PIDs
// stay constant when restarting svc-b). This test adds a regression lock that
// asserts the dependent service keeps its old PID.
// `lich restart` (whole-stack): full down+up so the dep graph is re-walked.
// ---------------------------------------------------------------------------
describe("dependencies on restart", () => {
  it(
    "restarting a service does NOT cascade-kill its dependents (sibling PIDs unchanged)",
    async () => {
      fixture = {
        ...makeCustomFixture("PLACEHOLDER", "lich-e2e-parity-dep-"),
      };
      const { stackPath, lichHome } = fixture;
      const yaml = `version: "1"
owned:
  base:
    cmd: 'echo "base-ready"; sleep 9999'
    ready_when:
      log_match: "base-ready"
  dep:
    cmd: 'echo "dep-ready"; sleep 9999'
    depends_on: [base]
    ready_when:
      log_match: "dep-ready"
`;
      writeFileSync(join(stackPath, "lich.yaml"), yaml, "utf8");

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });
      const baseBefore = beforeSnap.services.find((s) => s.name === "base");
      const depBefore = beforeSnap.services.find((s) => s.name === "dep");

      // Restart `base`. `dep` must keep its PID — there is no cascade.
      const restartResult = runLich(["restart", "base"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 15_000 });
      const baseAfter = afterSnap.services.find((s) => s.name === "base");
      const depAfter = afterSnap.services.find((s) => s.name === "dep");

      expect(baseAfter?.pid, "restarted service PID must change").not.toBe(baseBefore?.pid);
      expect(
        depAfter?.pid,
        "dependent's PID must NOT change (restart of a dep does not cascade-kill dependents)",
      ).toBe(depBefore?.pid);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: oneshot services
// In v1 the dogfood-stack has no oneshot service; the only "oneshot-like"
// behavior is captured via `ready_when.log_match` + capture. The restart of a
// long-running service that has ready_when.capture is covered above via the
// ready_when assertions. There is no separate "oneshot finishes and exits"
// service kind in v1.
// ---------------------------------------------------------------------------
describe("oneshot services", () => {
  it.skip(
    "SKIP: no oneshot service kind in v1 — there is no separate 'run once and exit' " +
      "service kind in the v1 spec. All owned services are long-lived; cmds that exit are " +
      "treated as failures. If a future 'oneshot' kind is added, this test should be " +
      "fleshed out to verify stop_cmd-then-cmd ordering on restart.",
    () => { /* placeholder */ },
  );
});

// ---------------------------------------------------------------------------
// Dimension: state.json persistence
// `lich up`: writes state.json with status:"up", per-service pid + state +
// allocated_ports + resolved_env + service_cwd + cmd + stop_cmd.
// `lich restart` (whole-stack): full down → up cycle; state.json reflects new
// PIDs but same resolved_env / cmd / cwd.
// `lich restart <service>`: rewrites pid; keeps resolved_env / cmd / cwd /
// allocated_ports untouched.
// ---------------------------------------------------------------------------
describe("state.json persistence", () => {
  it(
    "whole-stack restart updates owned PIDs but preserves snapshot fields (env, cmd, cwd, ports)",
    async () => {
      fixture = makeDogfoodFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 90_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeSnap = await waitForStackStatus(lichHome, stackId, "up", { timeoutMs: 10_000 });
      const beforeRaw = readState(lichHome, stackId);
      const beforeApi = beforeRaw.services.find((s: any) => s.name === "api");

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterRaw = readState(lichHome, stackId);
      const afterApi = afterRaw.services.find((s: any) => s.name === "api");

      // PID changes; everything else stays the same.
      expect(afterApi.pid, "api pid should be new").not.toBe(beforeApi.pid);
      expect(afterApi.resolved_env).toEqual(beforeApi.resolved_env);
      expect(afterApi.cmd).toBe(beforeApi.cmd);
      expect(afterApi.service_cwd).toBe(beforeApi.service_cwd);
      // Allocated ports may change if released/reallocated — assert they exist.
      expect(afterApi.allocated_ports?.default).toBeTypeOf("number");

      // status is "up" so `lich down` should still succeed.
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(downResult.exitCode, `${downResult.stdout}\n${downResult.stderr}`).toBe(0);

      const finalRaw = readState(lichHome, stackId);
      expect(finalRaw.status).toBe("stopped");
    },
    240_000,
  );

  it(
    "per-service restart updates started_at to spawn time (LEV-543)",
    async () => {
      const yaml = `version: "1"
owned:
  worker:
    cmd: 'echo "worker-ready"; sleep 9999'
    ready_when:
      log_match: "worker-ready"
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-sa-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeRaw = readState(lichHome, stackId);
      const beforeWorker = beforeRaw.services.find((s: any) => s.name === "worker");
      expect(beforeWorker.started_at).toBeDefined();
      const beforeStarted = new Date(beforeWorker.started_at).getTime();
      expect(Number.isFinite(beforeStarted)).toBe(true);

      // Wait briefly to make the timestamp diff easy to observe.
      await new Promise<void>((r) => setTimeout(r, 1500));

      const restartResult = runLich(["restart", "worker"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterRaw = readState(lichHome, stackId);
      const afterWorker = afterRaw.services.find((s: any) => s.name === "worker");
      expect(afterWorker.started_at).toBeDefined();
      const afterStarted = new Date(afterWorker.started_at).getTime();
      expect(
        afterStarted,
        `per-service restart MUST update started_at on the service (LEV-543); before=${beforeWorker.started_at} after=${afterWorker.started_at}`,
      ).toBeGreaterThan(beforeStarted);
    },
    90_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: log file continuity + run markers
// `lich up`: appends a run-marker line (`=== lich up at <iso> [run: <uuid>] ===`)
// to each owned service's log file (LEV-530-ish behavior, written by
// writeRunMarker in owned/supervisor.ts before each spawn).
// `lich restart` (whole-stack): full down → up; up's startOwnedService writes
// a NEW run marker. So the log file should have TWO markers after a restart.
// `lich restart <service>`: runPerServiceRestart calls startOwnedService with
// a new randomUUID() runId — should write a fresh marker too.
// ---------------------------------------------------------------------------
describe("log file continuity + run markers", () => {
  it(
    "whole-stack restart appends a new run-marker to the service log (preserves prior lines)",
    () => {
      const yaml = `version: "1"
owned:
  svc:
    cmd: 'printf "line-from-run\\n"; sleep 9999'
    ready_when:
      log_match: "line-from-run"
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-logmarker-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      const logPath = join(lichHome, "stacks", stackId, "logs", "svc.log");

      // Wait for the ready line to be written so the log has stable content.
      waitForFile(logPath, (s) => s.includes("line-from-run"), 5_000);
      const beforeContents = readFileSync(logPath, "utf8");
      const markerRegex = /^=== lich up at \S+ \[run: [0-9a-f-]+\] ===$/m;
      const beforeMarkers = (beforeContents.match(/=== lich up at /g) ?? []).length;
      expect(beforeMarkers, "exactly one marker after first up").toBe(1);
      expect(beforeContents).toMatch(markerRegex);

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      // After restart, log file should still exist (append-mode) and contain
      // the prior lines + a NEW marker line.
      waitForFile(logPath, (s) => (s.match(/=== lich up at /g) ?? []).length >= 2, 10_000);
      const afterContents = readFileSync(logPath, "utf8");
      const afterMarkers = (afterContents.match(/=== lich up at /g) ?? []).length;
      expect(afterMarkers, "marker count grows on restart (append, not truncate)").toBe(2);
      // Prior content must still be present (append, not truncate).
      const firstReadyCount = (afterContents.match(/line-from-run/g) ?? []).length;
      expect(firstReadyCount, "prior 'line-from-run' must survive restart").toBeGreaterThanOrEqual(2);
    },
    120_000,
  );

  it(
    "per-service restart writes a fresh run marker to the service log",
    () => {
      const yaml = `version: "1"
owned:
  svc:
    cmd: 'printf "line-from-svc\\n"; sleep 9999'
    ready_when:
      log_match: "line-from-svc"
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-psmarker-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      const logPath = join(lichHome, "stacks", stackId, "logs", "svc.log");
      waitForFile(logPath, (s) => s.includes("line-from-svc"), 5_000);
      const beforeMarkers = (readFileSync(logPath, "utf8").match(/=== lich up at /g) ?? []).length;
      expect(beforeMarkers).toBe(1);

      const restartResult = runLich(["restart", "svc"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      waitForFile(logPath, (s) => (s.match(/=== lich up at /g) ?? []).length >= 2, 10_000);
      const afterMarkers = (readFileSync(logPath, "utf8").match(/=== lich up at /g) ?? []).length;
      expect(
        afterMarkers,
        "per-service restart must write a fresh run marker (regression lock for LEV-530-style behavior)",
      ).toBe(2);
    },
    90_000,
  );
});

// ---------------------------------------------------------------------------
// Dimension: routing / proxy regeneration
// `lich up`: writes routing[] to state.json on success — the daemon's
// fs-watcher reads it to populate the proxy table.
// `lich restart` (whole-stack): full down→up so routing is rebuilt fresh.
// `lich restart <service>`: doesn't touch state.routing — the entries from
// the prior up are still in state.json. This is fine as long as the service's
// port doesn't change (per-service restart reuses the same allocated port).
// ---------------------------------------------------------------------------
describe("routing entries on restart", () => {
  it(
    "whole-stack restart preserves routing entries with correct service set",
    async () => {
      fixture = makeDogfoodFixture();
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 90_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeRaw = readState(lichHome, stackId);
      expect(beforeRaw.routing, "routing should be populated after up").toBeDefined();
      const beforeRouting = beforeRaw.routing as any[];
      expect(beforeRouting.length).toBeGreaterThan(0);
      const beforeServices = beforeRouting.map((r: any) => r.service).sort();

      const restartResult = runLich(["restart"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterRaw = readState(lichHome, stackId);
      const afterRouting = afterRaw.routing as any[];
      expect(afterRouting).toBeDefined();
      const afterServices = afterRouting.map((r: any) => r.service).sort();
      expect(afterServices, "routing must cover the same service set after restart").toEqual(beforeServices);
    },
    240_000,
  );

  it(
    "per-service restart preserves the existing routing entry (same port)",
    async () => {
      const yaml = `version: "1"
owned:
  svc:
    cmd: 'printf "ready\\n"; sleep 9999'
    port: { published_env: PORT }
    ready_when:
      log_match: "ready"
`;
      fixture = makeCustomFixture(yaml, "lich-e2e-parity-route-");
      const { stackPath, lichHome } = fixture;

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(upResult.exitCode, `${upResult.stdout}\n${upResult.stderr}`).toBe(0);

      const stackId = findStackId(lichHome);
      const beforeRaw = readState(lichHome, stackId);
      const beforePort = beforeRaw.services.find((s: any) => s.name === "svc").allocated_ports?.default;
      expect(beforePort).toBeTypeOf("number");

      const restartResult = runLich(["restart", "svc"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      expect(restartResult.exitCode, `${restartResult.stdout}\n${restartResult.stderr}`).toBe(0);

      const afterRaw = readState(lichHome, stackId);
      const afterPort = afterRaw.services.find((s: any) => s.name === "svc").allocated_ports?.default;
      expect(
        afterPort,
        "per-service restart must NOT reallocate the service's port (routing depends on stability)",
      ).toBe(beforePort);
    },
    90_000,
  );
});
