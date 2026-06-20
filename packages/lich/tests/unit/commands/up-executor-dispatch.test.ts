import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUp } from "../../../src/commands/up.js";
import * as executorMod from "../../../src/stack/executor.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-exec-"));
  projectDir = mkdtempSync(join(tmpdir(), "stack-up-exec-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LICH_HOME;
  else process.env.LICH_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("runUp — executor dispatch", () => {
  it("dispatches through pickExecutor.up (not direct runUpLocal call) when sandbox config is set", async () => {
    writeFileSync(
      join(projectDir, "lich.yaml"),
      `version: "1"
runtime:
  sandbox:
    backend: tart
    image: lich-sandbox-base
    bake_inputs: ["db/migrations/**"]
profiles:
  "dev:box":
    default: true
    owned: [web]
owned:
  web:
    cmd: "true"
`,
    );

    const fakeExecutor = {
      up: vi.fn(async () => ({ exitCode: 0 })),
      down: vi.fn(),
      exec: vi.fn(),
      logs: vi.fn(),
    };
    const spy = vi.spyOn(executorMod, "pickExecutor").mockReturnValue(fakeExecutor as any);

    const result = await runUp({ cwd: projectDir });
    expect(spy).toHaveBeenCalled();
    expect(fakeExecutor.up).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);

    spy.mockRestore();
  });

  it("falls through to runUpLocal for local (non-sandbox) configs", async () => {
    writeFileSync(
      join(projectDir, "lich.yaml"),
      `version: "1"
owned:
  web:
    cmd: "true"
`,
    );

    // runUpLocal will parse + fail with no profiles, but the important thing is
    // pickExecutor is NOT called with sandbox-tart.
    const spy = vi.spyOn(executorMod, "pickExecutor");

    // runUpLocal will run here — it may succeed or fail. What matters: if pickExecutor
    // is called, it must not be called with sandbox-tart kind.
    await runUp({ cwd: projectDir }).catch(() => {});

    for (const call of spy.mock.calls) {
      const snap = call[0] as any;
      expect(snap.executor?.kind ?? "local").not.toBe("sandbox-tart");
    }

    spy.mockRestore();
  });
});
