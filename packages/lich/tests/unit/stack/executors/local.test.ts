import { describe, it, expect, vi } from "vitest";
import { LocalStackExecutor } from "../../../../src/stack/executors/local.js";
import * as upMod from "../../../../src/commands/up.js";
import * as downMod from "../../../../src/commands/down.js";
import * as execMod from "../../../../src/commands/exec.js";
import * as logsMod from "../../../../src/commands/logs.js";

describe("LocalStackExecutor", () => {
  it("delegates down() to runDown unchanged", async () => {
    const spy = vi.spyOn(downMod, "runDown").mockResolvedValue({ exitCode: 0, warnings: [] });
    const exe = new LocalStackExecutor();
    const result = await exe.down({ purge: true, outputMode: "pretty" });
    expect(spy).toHaveBeenCalledWith({ purge: true, outputMode: "pretty" });
    expect(result.exitCode).toBe(0);
    spy.mockRestore();
  });

  it("delegates up() to runUp unchanged", async () => {
    const spy = vi.spyOn(upMod, "runUp").mockResolvedValue({ exitCode: 0 });
    const exe = new LocalStackExecutor();
    await exe.up({ outputMode: "pretty" } as any);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("delegates exec() to runExec unchanged", async () => {
    const spy = vi.spyOn(execMod, "runExec").mockResolvedValue({ exitCode: 0 });
    const exe = new LocalStackExecutor();
    await exe.exec({} as any);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("delegates logs() to runLogs unchanged", () => {
    const spy = vi.spyOn(logsMod, "runLogs").mockReturnValue({ exitCode: 0, done: Promise.resolve() });
    const exe = new LocalStackExecutor();
    exe.logs({ follow: false, count: 100, all: false, json: false } as any);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
