/**
 * Unit tests for `src/ready/timeout.ts` (Plan 4 Task 5).
 *
 * Covers two surfaces:
 *   - `withTimeout(promise, ms | { ms, phase })` — the deadline wrapper used
 *     by `up.ts` to bound each `ready_when` evaluator.
 *   - `parseDuration(value)` — the strict duration parser that turns the
 *     `ready_when.timeout` config field into a millisecond integer.
 *
 * The schema-level checks (rejecting `"forever"`, negatives, etc.) live in
 * `tests/unit/config/schema-ready-when-timeout.test.ts` to keep this file
 * focused on the runtime behaviour. Where the two overlap (e.g. negative
 * integers), the schema rejects FIRST at validate time; the parser doubles
 * down as a defence-in-depth check for any code path that bypasses validate.
 */

import { describe, expect, it } from "vitest";
import {
  parseDuration,
  ReadyTimeoutError,
  withTimeout,
} from "../../../src/ready/timeout.js";

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  it("resolves when the wrapped promise resolves before the deadline", async () => {
    // A promise that resolves well within the deadline must pass its value
    // through verbatim. This is the dominant happy path — ready evaluators
    // typically succeed in milliseconds (HTTP 200 on the third poll, etc.).
    const value = await withTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 10)),
      1_000,
    );
    expect(value).toBe("ready");
  });

  it("rejects with ReadyTimeoutError when the deadline elapses", async () => {
    // The wrapped promise never settles; the deadline (50ms) must win and
    // produce a ReadyTimeoutError. We assert `instanceof` because the
    // formatter (Plan 4 Task 9) discriminates on the class — using
    // duck-typing here would let a regression slip through.
    const neverResolves = new Promise<never>(() => {
      /* no-op */
    });
    await expect(withTimeout(neverResolves, 50)).rejects.toBeInstanceOf(
      ReadyTimeoutError,
    );
  });

  it("ReadyTimeoutError carries the configured duration in ms", async () => {
    // The error's `ms` field is the load-bearing piece for the failure
    // formatter — it renders "did not become ready within 50ms". Use an
    // explicit reject-handler so we can inspect the thrown value's fields
    // rather than just its message.
    const neverResolves = new Promise<never>(() => {
      /* no-op */
    });
    try {
      await withTimeout(neverResolves, 50);
      throw new Error("expected withTimeout to reject");
    } catch (err) {
      // Narrow before reading fields — TS doesn't know the shape on `catch`.
      expect(err).toBeInstanceOf(ReadyTimeoutError);
      const e = err as ReadyTimeoutError;
      expect(e.ms).toBe(50);
      // No phase was passed — phase is optional and should be undefined.
      expect(e.phase).toBeUndefined();
    }
  });

  it("ReadyTimeoutError carries the phase label when supplied", async () => {
    // Phase is the optional escape hatch for caller-supplied context (which
    // ready evaluator was the slow one). The orchestrator passes it when
    // racing a SINGLE evaluator; omits it when racing multiple.
    const neverResolves = new Promise<never>(() => {
      /* no-op */
    });
    try {
      await withTimeout(neverResolves, 25, /* not used */);
      throw new Error("expected withTimeout to reject");
    } catch {
      // Re-run with the options form to verify phase plumbing.
    }
    try {
      await withTimeout(neverResolves, { ms: 25, phase: "http_get" });
      throw new Error("expected withTimeout to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ReadyTimeoutError);
      const e = err as ReadyTimeoutError;
      expect(e.ms).toBe(25);
      expect(e.phase).toBe("http_get");
      // Verify the human-readable message mentions both pieces — the
      // formatter falls back to `error.message` for legacy renderers.
      expect(e.message).toMatch(/25ms/);
      expect(e.message).toMatch(/http_get/);
    }
  });

  it("propagates the wrapped promise's rejection unchanged", async () => {
    // If the wrapped promise rejects (e.g. abort signal fired) before the
    // deadline, the rejection should pass through with its original error.
    // The wrapper isn't a sanitizer — `up.ts` distinguishes abort vs
    // timeout by checking `instanceof ReadyTimeoutError`, so other errors
    // must NOT be rewrapped.
    const aborted = new Error("aborted");
    await expect(
      withTimeout(Promise.reject(aborted), 1_000),
    ).rejects.toBe(aborted);
  });

  it("does not fire the deadline after the wrapped promise resolves", async () => {
    // Defensive: an immediate resolve followed by a long deadline must not
    // somehow surface the timeout error later. The implementation tracks a
    // `settled` flag for this; the test wedges a small wait so any latent
    // timeout-fire would race in.
    const value = await withTimeout(
      Promise.resolve("done"),
      30,
    );
    expect(value).toBe("done");
    // Wait past the deadline to confirm no unhandled-rejection scream.
    await new Promise<void>((r) => setTimeout(r, 60));
  });

  it("does not fire the deadline after the wrapped promise rejects", async () => {
    // Same defensive check as above, on the rejection path. Without the
    // `settled` flag the timer would fire and try to reject a settled
    // promise — silent in practice but a latent bug.
    const err = new Error("inner failure");
    await expect(
      withTimeout(Promise.reject(err), 30),
    ).rejects.toBe(err);
    await new Promise<void>((r) => setTimeout(r, 60));
  });

  it("accepts either bare ms or options form", async () => {
    // Sanity: the two-arg form's overload accepts both shapes. Both must
    // resolve with the wrapped value identically.
    const a = await withTimeout(Promise.resolve(1), 100);
    const b = await withTimeout(Promise.resolve(2), { ms: 100 });
    const c = await withTimeout(Promise.resolve(3), {
      ms: 100,
      phase: "log_match",
    });
    expect([a, b, c]).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  // Table-driven: each row is (input, expected ms). Failures here usually
  // mean either the regex grammar changed or a suffix multiplier is wrong.
  // Add a row before changing the parser — keeps the surface area visible.
  const validCases: Array<[string | number, number]> = [
    // ---- string with explicit ms suffix ----
    ["500ms", 500],
    ["1ms", 1],
    ["60000ms", 60_000],
    // ---- string with second suffix ----
    ["30s", 30_000],
    ["60s", 60_000],
    ["1s", 1_000],
    // ---- string with minute suffix ----
    ["2m", 120_000],
    ["1m", 60_000],
    // ---- string with hour suffix ----
    ["1h", 3_600_000],
    ["2h", 7_200_000],
    // ---- bare-digits string (treated as ms — matches the `ms` suffix) ----
    ["500", 500],
    ["60000", 60_000],
    // ---- raw integers (interpreted as ms) ----
    [500, 500],
    [60_000, 60_000],
    [1, 1],
  ];

  it("parseDuration accepts seconds, minutes, hours, ms, and raw integers", () => {
    for (const [input, expected] of validCases) {
      // Wrap each assertion in a try/catch so a single bad row names
      // itself in the failure output (otherwise vitest reports a generic
      // "expected X to equal Y" without telling you WHICH row).
      try {
        expect(parseDuration(input)).toBe(expected);
      } catch (err) {
        // Re-throw with the input as context so debugging the failing
        // row doesn't require counting iterations.
        throw new Error(
          `parseDuration(${JSON.stringify(input)}) failed: ${(err as Error).message}`,
        );
      }
    }
  });

  it("parseDuration rejects malformed strings with a useful message", () => {
    // The error message should at minimum mention the offending input so
    // a user pasted into a search bar finds their own config.
    const cases: string[] = [
      "forever", // semantic nonsense
      "5 minutes", // wrong grammar (whitespace + word suffix)
      "30sec", // unknown suffix
      "-1s", // negative not allowed
      "1.5s", // decimals not allowed
      "0", // zero (not positive)
      "0s", // zero with suffix
      "", // empty string
      "  ", // whitespace only
      "+10s", // signed positive not allowed
      "s", // suffix without digits
      "10m30s", // composite not supported (one suffix only)
    ];
    for (const input of cases) {
      try {
        // Each input should throw; if any silently returns we fail the
        // test with a message that names the surviving input.
        const result = parseDuration(input);
        throw new Error(
          `parseDuration(${JSON.stringify(input)}) should have thrown, returned ${result}`,
        );
      } catch (err) {
        // Two acceptable shapes: the parser threw (good), or our own
        // assertion threw above (bad). Disambiguate by checking message.
        const msg = (err as Error).message;
        if (msg.includes("should have thrown")) throw err;
        // Useful-message requirement: the error must reference the input
        // somewhere (so users grep for their own value) OR call out
        // "empty"/"positive" for the degenerate cases.
        const mentionsInput =
          msg.includes(JSON.stringify(input)) ||
          msg.includes(`"${input}"`) ||
          msg.includes(input) ||
          input.trim() === "" ||
          input === "0" ||
          input === "0s";
        expect(mentionsInput).toBe(true);
      }
    }
  });

  it("rejects raw integers that aren't positive whole numbers", () => {
    // The schema rejects these at validate time; the parser is the
    // defence-in-depth layer for callers that pre-build values from JS.
    const cases: number[] = [
      0, // zero
      -1, // negative
      -500, // larger negative
      1.5, // float
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const input of cases) {
      try {
        const result = parseDuration(input);
        throw new Error(
          `parseDuration(${input}) should have thrown, returned ${result}`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("should have thrown")) throw err;
        // Confirm we got a real Error, not something incidental.
        expect(err).toBeInstanceOf(Error);
      }
    }
  });

  it("rejects non-string non-number inputs with a useful message", () => {
    // Defensive: a malformed runtime value (e.g. a yaml mapping that
    // sneaked through a wider-than-expected upstream type) should fail
    // loudly rather than coerce silently.
    // @ts-expect-error: deliberately wrong-shape input for runtime check
    expect(() => parseDuration({})).toThrow(/string or number/);
    // @ts-expect-error: deliberately wrong-shape input for runtime check
    expect(() => parseDuration(null)).toThrow(/string or number/);
    // @ts-expect-error: deliberately wrong-shape input for runtime check
    expect(() => parseDuration(undefined)).toThrow(/string or number/);
    // @ts-expect-error: deliberately wrong-shape input for runtime check
    expect(() => parseDuration(true)).toThrow(/string or number/);
  });
});
