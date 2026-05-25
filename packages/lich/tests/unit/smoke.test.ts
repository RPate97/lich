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
    // their own tests cover behavior. Plan 2 promotes `help` (LEV-329),
    // `exec` (LEV-330), and `env` (LEV-331) to real handlers. Plan 5
    // Task 19 (LEV-421) promotes `restart`. With all commands now wired
    // to real handlers, the stub set is empty — this assertion stays so
    // any future stub re-introduction is caught.
    const STUB_COMMANDS = new Set<string>([]);
    for (const [name, fn] of Object.entries(COMMANDS)) {
      if (!STUB_COMMANDS.has(name)) continue;
      const result = await fn({ argv: { _: [] } });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(name);
    }
  });

  it("help/exec/env are real handlers, not stubs", async () => {
    // Plan 2 Task 12 (LEV-332): the router wires runHelp/runExec/runEnvCmd
    // for these three names. This assertion guards against a regression
    // where the wiring is reverted to `stub("help")` etc. — each handler,
    // invoked with minimal argv, must NOT return the not-yet-implemented
    // stub message.
    //
    // - `help` with empty argv enters list mode (tolerant of missing
    //   lich.yaml; prints built-ins to stdout). We silence console.log so
    //   it doesn't pollute the test output.
    // - `exec` with empty argv exits 2 with a usage message on stderr
    //   (no filesystem IO).
    // - `env` with empty argv exits 2 with a usage message on stderr
    //   (no filesystem IO).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      for (const name of ["help", "exec", "env"] as const) {
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
