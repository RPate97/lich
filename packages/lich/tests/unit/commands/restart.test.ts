/**
 * Unit tests for `lich restart` (Plan 5 Task 19 / LEV-421).
 *
 * Strategy: mock the underlying `runDown` and `runUp` modules so we can
 * verify the ordering, exit-code propagation, and signal threading without
 * spinning up the full pipeline that the sibling `up.test.ts` and
 * `down.test.ts` already exercise end-to-end. `runRestart` is intentionally
 * a thin shim — its contract is "down then up, abort on down failure",
 * which is exactly what we test here.
 *
 * Coverage:
 *   1. Happy path: down succeeds → up runs → returns up's exit 0.
 *   2. Down fails (non-zero) → up is NOT called; restart returns down's code.
 *   3. Down ok but up fails → restart returns up's exit code.
 *   4. No stack up (down returns exit 0 with no-op) → up still runs.
 *   5. Pass-through: cwd flows to both down and up.
 *   6. Pass-through: signal flows to both down and up.
 *   7. Pass-through: outputMode and out flow to up (down doesn't honor
 *      outputMode in Plan 1, only out).
 *   8. Result-shape pass-through: stackId/services from up surface on the
 *      restart result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock MUST be hoisted above the module imports so vitest substitutes
// the fakes before `restart.ts` evaluates its `import` statements. Vitest
// auto-hoists when the call sits at module scope (which it does here).
const runDownSpy = vi.fn(
  async () => ({ exitCode: 0, warnings: [] }) as { exitCode: number; warnings: unknown[] },
);
const runUpSpy = vi.fn(
  async () => ({ exitCode: 0 }) as {
    exitCode: number;
    stackId?: string;
    services?: Array<{ name: string; state: string }>;
  },
);
vi.mock("../../../src/commands/down.js", () => ({
  runDown: (...args: unknown[]) => runDownSpy(...args),
}));
vi.mock("../../../src/commands/up.js", () => ({
  runUp: (...args: unknown[]) => runUpSpy(...args),
}));

import { runRestart } from "../../../src/commands/restart.js";

beforeEach(() => {
  runDownSpy.mockClear();
  runUpSpy.mockClear();
  runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
  runUpSpy.mockImplementation(async () => ({ exitCode: 0 }));
});

afterEach(() => {
  // Defensive reset — each test's beforeEach reinstalls the default impls,
  // but a test that uses mockImplementationOnce shouldn't leak into the
  // next test's mockClear-only setup.
  runDownSpy.mockReset();
  runUpSpy.mockReset();
});

describe("runRestart — happy path: down + up", () => {
  it("invokes runDown first, then runUp, returns exit 0 when both succeed", async () => {
    const order: string[] = [];
    runDownSpy.mockImplementation(async () => {
      order.push("down");
      return { exitCode: 0, warnings: [] };
    });
    runUpSpy.mockImplementation(async () => {
      order.push("up");
      return { exitCode: 0 };
    });

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["down", "up"]);
  });
});

describe("runRestart — down fails: short-circuit before up", () => {
  it("returns down's non-zero exit code WITHOUT calling runUp", async () => {
    runDownSpy.mockImplementation(async () => ({
      exitCode: 2,
      warnings: [{ phase: "stop_owned", message: "boom" }],
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(2);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    // Critical: don't try to up a broken state.
    expect(runUpSpy).not.toHaveBeenCalled();
    // Down-failure path doesn't have an up result to surface, so the
    // stackId / services fields are absent on the restart result.
    expect(result.stackId).toBeUndefined();
    expect(result.services).toBeUndefined();
  });

  it("forwards an arbitrary non-zero down exit (e.g. 7) verbatim", async () => {
    // Pin "first non-zero code from the down-then-up sequence" verbatim —
    // we don't want a future change to coerce all down failures to 1.
    runDownSpy.mockImplementation(async () => ({ exitCode: 7, warnings: [] }));

    const result = await runRestart({});
    expect(result.exitCode).toBe(7);
    expect(runUpSpy).not.toHaveBeenCalled();
  });
});

describe("runRestart — down ok, up fails", () => {
  it("returns up's exit code when up fails after a successful down", async () => {
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async () => ({ exitCode: 1, stackId: "abc" }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(1);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    // Result still carries the up-side metadata so the caller can inspect
    // what was attempted even on failure.
    expect(result.stackId).toBe("abc");
  });
});

describe("runRestart — no stack up (down is a tolerant no-op)", () => {
  it("proceeds to up when down returns 0 with 'no stack found' (idempotent)", async () => {
    // `runDown` returns exit 0 for both "no state.json" and "already
    // stopped" cases — restart shouldn't treat that as a failure.
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async () => ({
      exitCode: 0,
      stackId: "fresh-stack",
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
    expect(result.stackId).toBe("fresh-stack");
  });
});

describe("runRestart — argument pass-through", () => {
  it("forwards cwd to both runDown and runUp", async () => {
    const cwd = "/tmp/some-worktree";
    await runRestart({ cwd });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({ cwd });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ cwd });
  });

  it("forwards signal to both runDown and runUp", async () => {
    const controller = new AbortController();
    await runRestart({ signal: controller.signal });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("forwards outputMode to runUp (down doesn't accept it in Plan 1)", async () => {
    await runRestart({ outputMode: "json" });

    // runUp accepts outputMode; runDown does not — verify each receives
    // exactly what its API supports.
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ outputMode: "json" });
    expect(runDownSpy.mock.calls[0][0]).not.toHaveProperty("outputMode");
  });

  it("forwards `out` writable stream to both runDown and runUp", async () => {
    // Both commands accept an `out` sink for the CLI surface; restart should
    // thread the same one through so a `--quiet` / piped restart routes both
    // halves' output to the same place.
    const fakeStream = { write: () => true } as unknown as NodeJS.WritableStream;
    await runRestart({ out: fakeStream });

    expect(runDownSpy.mock.calls[0][0]).toMatchObject({ out: fakeStream });
    expect(runUpSpy.mock.calls[0][0]).toMatchObject({ out: fakeStream });
  });
});

describe("runRestart — result-shape pass-through from runUp", () => {
  it("propagates stackId and services from runUp's result", async () => {
    runUpSpy.mockImplementation(async () => ({
      exitCode: 0,
      stackId: "stack-abc",
      services: [
        { name: "api", state: "ready" },
        { name: "web", state: "ready" },
      ],
    }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(0);
    expect(result.stackId).toBe("stack-abc");
    expect(result.services).toEqual([
      { name: "api", state: "ready" },
      { name: "web", state: "ready" },
    ]);
  });

  it("omits stackId/services from result when runUp didn't supply them", async () => {
    // runUp can return a bare { exitCode } (e.g. on early validation
    // failure before stack_id is known). Restart should preserve that —
    // not synthesize an undefined-but-present field.
    runUpSpy.mockImplementation(async () => ({ exitCode: 1 }));

    const result = await runRestart({});

    expect(result.exitCode).toBe(1);
    expect("stackId" in result).toBe(false);
    expect("services" in result).toBe(false);
  });
});

describe("runRestart — AbortSignal mid-flight", () => {
  it("aborts cleanly when signal fires during runDown (down exit propagates)", async () => {
    const controller = new AbortController();
    // Simulate a runDown that observes the signal and returns a non-zero
    // exit (matching down.ts's signal-on-grace behavior — Ctrl-C cuts the
    // grace short and the function still returns a result).
    runDownSpy.mockImplementation(async (input: unknown) => {
      const opts = input as { signal?: AbortSignal };
      controller.abort();
      // runDown is best-effort: in real usage it'd still return exit 0 even
      // when signalled (graceful teardown of what it can). For the abort
      // case we simulate a non-zero to verify restart honors the
      // short-circuit contract regardless of cause.
      return {
        exitCode: opts.signal?.aborted ? 130 : 0,
        warnings: [],
      };
    });

    const result = await runRestart({ signal: controller.signal });
    expect(result.exitCode).toBe(130);
    // up MUST NOT run after a failing down — even if the failure was a
    // signal-triggered abort. Otherwise Ctrl-C during a restart could
    // start spinning up an in-flight teardown.
    expect(runUpSpy).not.toHaveBeenCalled();
  });

  it("aborts cleanly when signal fires during runUp (up exit propagates)", async () => {
    const controller = new AbortController();
    runDownSpy.mockImplementation(async () => ({ exitCode: 0, warnings: [] }));
    runUpSpy.mockImplementation(async (input: unknown) => {
      const opts = input as { signal?: AbortSignal };
      controller.abort();
      return { exitCode: opts.signal?.aborted ? 1 : 0 };
    });

    const result = await runRestart({ signal: controller.signal });
    expect(result.exitCode).toBe(1);
    expect(runDownSpy).toHaveBeenCalledTimes(1);
    expect(runUpSpy).toHaveBeenCalledTimes(1);
  });
});
