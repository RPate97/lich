import { describe, it, expect, vi } from "vitest";
import { runUp } from "../../../src/commands/up.js";
import * as upMod from "../../../src/commands/up.js";

describe("runUp — executor dispatch", () => {
  it("delegates to runUpLocal", async () => {
    const spy = vi.spyOn(upMod, "runUpLocal").mockResolvedValue({ exitCode: 0 });
    const result = await runUp({ outputMode: "pretty" } as any);
    expect(result.exitCode).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ outputMode: "pretty" });
    spy.mockRestore();
  });
});
