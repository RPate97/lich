import { describe, it, expect } from "vitest";
import type { StackExecutor } from "../../../src/stack/executor.js";
import type { RunDownInput, RunDownResult } from "../../../src/commands/down.js";

describe("StackExecutor interface", () => {
  it("declares up/down/exec/logs methods returning the Run*Result shapes", () => {
    const fake: StackExecutor = {
      async up() { return { exitCode: 0 } as any; },
      async down(input: RunDownInput): Promise<RunDownResult> {
        return { exitCode: 0, warnings: [] };
      },
      async exec() { return { exitCode: 0 } as any; },
      logs() { return { exitCode: 0, done: Promise.resolve() } as any; },
    };
    expect(typeof fake.down).toBe("function");
    expect(typeof fake.up).toBe("function");
    expect(typeof fake.exec).toBe("function");
    expect(typeof fake.logs).toBe("function");
  });
});
