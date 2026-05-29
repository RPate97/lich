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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import { waitForStackStatus } from "../helpers/state.js";
import { LICH_BINARY as lichBinary, LICH_PACKAGE as lichPackage } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: lichPackage,
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
  lichHome: string;
  cleanup: () => void;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  const stackPath = mkdtempSync(join(tmpdir(), "lich-e2e-discover-profile-"));
  const lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-discover-profile-home-"));

  mkdirSync(join(stackPath, ".git"));
  writeFileSync(join(stackPath, ".git", "HEAD"), "ref: refs/heads/main\n");

  mkdirSync(join(stackPath, "workers"), { recursive: true });
  for (const name of ["billing", "events", "notifications"]) {
    writeFileSync(
      join(stackPath, "workers", `${name}-worker.sh`),
      `#!/bin/sh\necho "${name}-worker ready"\nexec sleep 99999\n`,
      { mode: 0o755 },
    );
  }

  writeFileSync(
    join(stackPath, "lich.yaml"),
    [
      'version: "1"',
      "",
      "owned:",
      "  events-workers:",
      "    discover:",
      '      glob: "workers/*.sh"',
      '      name_template: "${basename_no_ext}"',
      '      cmd_template: "sh workers/${basename}"',
      "    ready_when:",
      '      log_match: "ready"',
      "      timeout: 10s",
      "",
      "profiles:",
      "  default:",
      "    default: true",
      "    owned: [events-workers]",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    stackPath,
    lichHome,
    cleanup: () => {
      rmSync(stackPath, { recursive: true, force: true });
      rmSync(lichHome, { recursive: true, force: true });
    },
  };
}

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (entries.length === 0) return null;
  return entries[0];
}

afterEach(() => {
  if (!fixture) return;
  try {
    runLich(["down"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("afterEach lich down failed:", err);
  }
  try {
    runLich(["nuke", "--yes"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  fixture.cleanup();
  fixture = null;
});

describe("discover: parent name in profile owned: (LEV-520)", () => {
  it(
    "lich up expands the discover parent name to all 3 materialized services",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      if (validateResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("validate stdout:", validateResult.stdout);
        // eslint-disable-next-line no-console
        console.error("validate stderr:", validateResult.stderr);
      }
      expect(validateResult.exitCode).toBe(0);

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();

      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 15_000,
      });

      const serviceNames = snap.services.map((s) => s.name).sort();
      expect(serviceNames).toEqual([
        "billing-worker",
        "events-worker",
        "notifications-worker",
      ]);

      for (const svc of snap.services) {
        expect(
          svc.state,
          `service ${svc.name} expected state=ready`,
        ).toBe("ready");
      }
    },
    60_000,
  );

  it("lich validate reports 3 owned services when profile references the discover parent", () => {
    fixture = makeFixture();
    const { stackPath, lichHome } = fixture;

    const result = runLich(["validate", "--json"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      summary?: { owned?: number };
    };
    expect(report.ok).toBe(true);
    expect(report.summary?.owned).toBe(3);
  });

  it("per-name listing of discovered children still works (back-compat)", () => {
    fixture = makeFixture();
    const { stackPath, lichHome } = fixture;

    writeFileSync(
      join(stackPath, "lich.yaml"),
      [
        'version: "1"',
        "",
        "owned:",
        "  events-workers:",
        "    discover:",
        '      glob: "workers/*.sh"',
        '      name_template: "${basename_no_ext}"',
        '      cmd_template: "sh workers/${basename}"',
        "    ready_when:",
        '      log_match: "ready"',
        "      timeout: 10s",
        "",
        "profiles:",
        "  default:",
        "    default: true",
        "    owned: [billing-worker, events-worker, notifications-worker]",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runLich(["validate", "--json"], {
      cwd: stackPath,
      env: { LICH_HOME: lichHome },
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      summary?: { owned?: number };
    };
    expect(report.ok).toBe(true);
    expect(report.summary?.owned).toBe(3);
  });
});
