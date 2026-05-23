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

  it("every command stub returns not-yet-implemented", () => {
    // Commands that have a real implementation are excluded from the
    // stub-shape check; their own tests cover behavior.
    const implemented = new Set<string>(["init"]);
    for (const [name, fn] of Object.entries(COMMANDS)) {
      if (implemented.has(name)) continue;
      const result = fn();
      expect(result.ok).toBe(false);
      expect(result.message).toContain(name);
    }
  });
});
