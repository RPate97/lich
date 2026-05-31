import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "bun:test";

// Capture REAL `runUp` before installing the mock. Bun's `mock.module`
// (which `vi.mock` desugars to) is GLOBAL — restored in afterAll so later
// test files in the same bun test run get the real function.
const realUpModule = await import("../../../src/commands/up.js");
const realRunUp = realUpModule.runUp;

const runUpSpy = vi.fn(async (..._args: unknown[]) => ({ exitCode: 0 }));
vi.mock("../../../src/commands/up.js", () => ({
  runUp: (...args: unknown[]) => runUpSpy(...args),
}));

import { COMMANDS } from "../../../src/commands/index.js";

beforeEach(() => {
  runUpSpy.mockClear();
  runUpSpy.mockImplementation(async () => ({ exitCode: 0 }));
});

afterEach(() => {
  runUpSpy.mockReset();
});

afterAll(() => {
  mock.module("../../../src/commands/up.js", () => ({
    ...realUpModule,
    runUp: realRunUp,
  }));
});

describe("upHandler — positional profile forwarding", () => {
  it("argv._[0] becomes input.profile in runUp", async () => {
    const result = await COMMANDS.up({
      argv: { _: ["dev:env-override"] },
    });

    expect(result.ok).toBe(true);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    const arg = runUpSpy.mock.calls[0][0] as { profile?: string };
    expect(arg.profile).toBe("dev:env-override");
  });

  it("no positional → profile is undefined", async () => {
    const result = await COMMANDS.up({
      argv: { _: [] },
    });

    expect(result.ok).toBe(true);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    const arg = runUpSpy.mock.calls[0][0] as { profile?: string };
    expect(arg.profile).toBeUndefined();
  });

  it("`lich up dev:test-env` invokes runUp with profile 'dev:test-env'", async () => {
    await COMMANDS.up({
      argv: { _: ["dev:test-env"] },
    });

    const arg = runUpSpy.mock.calls[0][0] as { profile?: string };
    expect(arg.profile).toBe("dev:test-env");
  });

  it("preserves --json flag handling while forwarding profile", async () => {
    await COMMANDS.up({
      argv: { _: ["dev"], json: true },
    });

    const arg = runUpSpy.mock.calls[0][0] as {
      profile?: string;
      outputMode?: string;
    };
    expect(arg.profile).toBe("dev");
    expect(arg.outputMode).toBe("json");
  });

  it("preserves --quiet flag handling while forwarding profile", async () => {
    await COMMANDS.up({
      argv: { _: ["dev"], quiet: true },
    });

    const arg = runUpSpy.mock.calls[0][0] as {
      profile?: string;
      outputMode?: string;
    };
    expect(arg.profile).toBe("dev");
    expect(arg.outputMode).toBe("quiet");
  });

  it("defaults outputMode to 'pretty' when no flag set", async () => {
    await COMMANDS.up({
      argv: { _: ["dev"] },
    });

    const arg = runUpSpy.mock.calls[0][0] as {
      profile?: string;
      outputMode?: string;
    };
    expect(arg.profile).toBe("dev");
    expect(arg.outputMode).toBe("pretty");
  });

  it("forwards ctx.signal alongside profile", async () => {
    const controller = new AbortController();
    await COMMANDS.up({
      argv: { _: ["dev"] },
      signal: controller.signal,
    });

    const arg = runUpSpy.mock.calls[0][0] as {
      profile?: string;
      signal?: AbortSignal;
    };
    expect(arg.profile).toBe("dev");
    expect(arg.signal).toBe(controller.signal);
  });

  it("coerces non-string positional to undefined defensively", async () => {
    // mri parses positionals as strings; guard for future router changes
    // (e.g. structured argv from programmatic callers)
    await COMMANDS.up({
      argv: { _: [123 as unknown as string] },
    });

    const arg = runUpSpy.mock.calls[0][0] as { profile?: string };
    expect(arg.profile).toBeUndefined();
  });

  it("non-zero runUp exit propagates to handler ok=false", async () => {
    runUpSpy.mockImplementation(async () => ({ exitCode: 1 }));
    const result = await COMMANDS.up({
      argv: { _: ["dev"] },
    });
    expect(result.ok).toBe(false);
  });
});
