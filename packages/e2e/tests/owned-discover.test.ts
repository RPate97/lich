import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import {
  LICH_BINARY as lichBinary,
  LICH_PACKAGE as lichPackage,
} from "@/helpers/paths.js";

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

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-discover-e2e-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function touch(relPath: string): void {
  const abs = join(tmp, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, "// stub for owned-discover e2e test\n");
}

function writeYaml(body: string): string {
  const p = join(tmp, "lich.yaml");
  writeFileSync(p, body);
  return p;
}

describe("lich validate — owned.discover expansion", () => {
  it("accepts a yaml with a discover block and reports the expanded owned count", () => {
    touch("apps/workers/src/temporal/workers/AlphaTemporalWorker.ts");
    touch("apps/workers/src/temporal/workers/BetaTemporalWorker.ts");
    touch("apps/workers/src/temporal/workers/GammaTemporalWorker.ts");
    // non-matching file proves the glob filters
    touch("apps/workers/src/temporal/workers/index.ts");

    writeYaml(
      [
        'version: "1"',
        "owned:",
        "  workers:",
        "    discover:",
        '      glob: "src/temporal/workers/*TemporalWorker.ts"',
        '      name_template: "${basename_no_ext | strip_suffix:TemporalWorker | kebab}-worker"',
        '      cmd_template: "node dist/temporal/workers/${basename_no_ext}.js"',
        "      cwd: apps/workers",
        "    ready_when:",
        '      log_match: "Worker created"',
        "",
      ].join("\n"),
    );

    const pretty = runLich(["validate"], { cwd: tmp });
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stdout).toContain("3 owned services");
    expect(pretty.stdout).not.toMatch(/0 owned service/);
    expect(pretty.stderr).toBe("");

    const json = runLich(["validate", "--json"], { cwd: tmp });
    expect(json.exitCode).toBe(0);
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      summary?: { owned?: number };
    };
    expect(report.ok).toBe(true);
    expect(report.summary?.owned).toBe(3);
  });

  it("exits 1 with a clear error when a template references an unknown variable", () => {
    touch("workers/Foo.ts");
    writeYaml(
      [
        'version: "1"',
        "owned:",
        "  ws:",
        "    discover:",
        '      glob: "workers/*.ts"',
        // Typo: `basenmae` (one transposition away from `basename`).
        '      name_template: "${basenmae}"',
        '      cmd_template: "node ${basename}"',
        "",
      ].join("\n"),
    );

    const result = runLich(["validate"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown template var/);
    expect(result.stderr).toContain("basenmae");
    expect(result.stderr).toContain("basename");
    expect(result.stderr).toContain("did you mean");
    expect(result.stderr).toContain("name_template");
  });

  it("exits 1 when a synthetic service name collides with a hand-written entry", () => {
    touch("workers/api.ts");
    writeYaml(
      [
        'version: "1"',
        "owned:",
        "  api:",
        "    cmd: bun run dev",
        "  workers:",
        "    discover:",
        '      glob: "workers/*.ts"',
        '      name_template: "${basename_no_ext}"',
        '      cmd_template: "node ${basename}"',
        "",
      ].join("\n"),
    );

    const result = runLich(["validate"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/collide/i);
  });

  it("exits 1 when discover and cmd are both set on the same entry (mutual exclusivity)", () => {
    writeYaml(
      [
        'version: "1"',
        "owned:",
        "  ws:",
        "    cmd: bun run dev",
        "    discover:",
        '      glob: "workers/*.ts"',
        '      name_template: "${basename_no_ext}"',
        '      cmd_template: "node ${basename}"',
        "",
      ].join("\n"),
    );

    const result = runLich(["validate"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/owned/ws");
  });
});
