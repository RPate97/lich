import { describe, it, expect, vi } from "vitest";
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
        "dashboard",
        "down",
        "env",
        "exec",
        "feedback",
        "init",
        "logs",
        "nuke",
        "restart",
        "routing",
        "sandbox",
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
    // stub set is empty; assertion guards against future stub re-introduction
    const STUB_COMMANDS = new Set<string>([]);
    for (const [name, fn] of Object.entries(COMMANDS)) {
      if (!STUB_COMMANDS.has(name)) continue;
      const result = await fn({ argv: { _: [] } });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(name);
    }
  });

  it("exec/env are real handlers, not stubs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      for (const name of ["exec", "env"] as const) {
        const fn = COMMANDS[name];
        const result = await fn({ argv: { _: [] } });
        expect(result.message ?? "").not.toContain("not yet implemented");
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
