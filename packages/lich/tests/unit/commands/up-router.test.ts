/**
 * Unit tests for the router → `runUp` wiring — LEV-391 (Plan 3 Task 17).
 *
 * Strategy: stub the `runUp` module so the handler under test (the
 * `upHandler` in `commands/index.ts`) routes its `ctx.argv` through a
 * fake `runUp` we inspect, without spinning up the full pipeline that the
 * sibling `up.test.ts` already exercises end-to-end.
 *
 * Why a dedicated file rather than extending `up.test.ts`: the routing
 * contract is "the first positional after `up` becomes `input.profile`",
 * a one-line wiring that has nothing to do with the real `runUp`'s
 * docker/port/state surface. Co-locating with `up.test.ts` would force
 * us to either skip the heavy `beforeEach`/`afterEach` (creating LICH_HOME
 * tmpdirs, releasing port allocations) or duplicate the spawn-real-services
 * scaffolding for a test that wants to assert one captured argument.
 *
 * The plan's note explicitly allows splitting into a separate file
 * (Task 17 implementation notes: "or add a new `bin/up-arg.test.ts` if
 * `up.test.ts` doesn't easily route through the router"); we choose
 * `commands/up-router.test.ts` so the file sits next to the other
 * command-level tests it relates to.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "bun:test";

// Capture the REAL `runUp` before we install the mock. Bun's `mock.module`
// (which `vi.mock` desugars to under `bun test`) is GLOBAL — once installed,
// subsequent test files in the same `bun test` invocation see the mocked
// module too. We need to (a) hold a stable reference to the real export
// here, (b) install the test mock, (c) restore the real module in
// `afterAll` so later test files that import `runUp` for real (e.g.
// up-routing.test.ts, up-failure-wiring.test.ts) get the actual function
// back instead of an unconfigured spy returning `undefined`.
const realUpModule = await import("../../../src/commands/up.js");
const realRunUp = realUpModule.runUp;

// vi.mock MUST be hoisted ABOVE the import of the module under test so vitest
// substitutes the fake before `commands/index.js` evaluates `import { runUp }
// from "./up.js"`. Vitest performs the hoist automatically when the call is
// at module scope (which it is here).
const runUpSpy = vi.fn(async () => ({ exitCode: 0 }));
vi.mock("../../../src/commands/up.js", () => ({
  runUp: (...args: unknown[]) => runUpSpy(...args),
}));

import { COMMANDS } from "../../../src/commands/index.js";

beforeEach(() => {
  runUpSpy.mockClear();
  runUpSpy.mockImplementation(async () => ({ exitCode: 0 }));
});

afterEach(() => {
  // Defensive: each test reinitializes via beforeEach, but reset implementations
  // here too so a custom mockImplementation in one test doesn't leak into a
  // later mockClear-only setup elsewhere in the file.
  runUpSpy.mockReset();
});

afterAll(() => {
  // Restore the REAL `runUp` for any test file that runs after this one in
  // the same `bun test` invocation. Without this, the global mock would
  // leak and subsequent files would see `runUpSpy` (post-reset, returning
  // `undefined`) instead of the real implementation.
  mock.module("../../../src/commands/up.js", () => ({
    ...realUpModule,
    runUp: realRunUp,
  }));
});

describe("upHandler — LEV-391: positional profile forwarding", () => {
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
    // Pinned to the spec wording in the LEV-391 acceptance criteria —
    // mirrors the example in the issue body so any future regression
    // shows up against the same literal name the spec talks about.
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
    // mri parses positional argv as strings, so this case can't happen via
    // the real bin layer today. The handler still guards against future
    // router changes that might surface a non-string positional (e.g. a
    // structured argv from a programmatic caller). Pin the coercion so a
    // later refactor of the guard surfaces here.
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
