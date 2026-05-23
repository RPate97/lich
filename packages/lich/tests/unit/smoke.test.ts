import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/version.js";
import { COMMANDS, isCommand } from "../../src/commands/index.js";

describe("smoke", () => {
  it("exports a VERSION string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("declares the expected command names", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "down",
        "env",
        "exec",
        "help",
        "init",
        "logs",
        "nuke",
        "restart",
        "stacks",
        "up",
        "urls",
        "validate",
      ].sort()
    );
  });

  it("isCommand returns true for known and false for unknown", () => {
    expect(isCommand("up")).toBe(true);
    expect(isCommand("nope")).toBe(false);
  });

  it("every unimplemented command stub returns not-yet-implemented", async () => {
    // Commands implemented in Plan 1 are excluded from the stub sweep;
    // their own tests cover behavior. restart/help/exec/env land in later plans.
    const implemented = new Set<string>([
      "init",
      "validate",
      "up",
      "logs",
      "urls",
      "stacks",
      "nuke",
    ]);
    // down lands in a follow-up commit once LEV-291's down.ts is on master.
    for (const [name, fn] of Object.entries(COMMANDS)) {
      if (implemented.has(name)) continue;
      const result = await fn({ argv: { _: [] } });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(name);
    }
  });
});
