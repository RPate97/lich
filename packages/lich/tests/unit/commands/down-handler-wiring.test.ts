import { describe, expect, it } from "vitest";
import { buildDownInput } from "../../../src/commands/index.js";

// Regression: downHandler used to drop ctx.argv.purge silently, so
// `lich down --purge` reached runDown with purge=undefined and the
// sandbox routing block never fired.

describe("buildDownInput", () => {
  it("propagates --purge", () => {
    const input = buildDownInput({ purge: true, _: [] });
    expect(input.purge).toBe(true);
  });

  it("omits --purge when not set (treated as false)", () => {
    const input = buildDownInput({ _: [] });
    expect(input.purge).toBe(false);
  });

  it("--purge=false is honored (not coerced to true)", () => {
    const input = buildDownInput({ purge: false, _: [] });
    expect(input.purge).toBe(false);
  });

  it("maps --json to outputMode:json", () => {
    const input = buildDownInput({ json: true, _: [] });
    expect(input.outputMode).toBe("json");
  });

  it("maps --quiet to outputMode:quiet", () => {
    const input = buildDownInput({ quiet: true, _: [] });
    expect(input.outputMode).toBe("quiet");
  });

  it("defaults outputMode to pretty", () => {
    const input = buildDownInput({ _: [] });
    expect(input.outputMode).toBe("pretty");
  });
});
