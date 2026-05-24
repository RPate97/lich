/**
 * Schema tests for `ready_when.timeout` (Plan 4 Task 5 tightening).
 *
 * Before this task, `timeout` was accepted as `unknown` — any shape passed
 * validate. This task tightens it to: a duration string matching
 * `^[0-9]+(ms|s|m|h)?$` OR a positive integer (ms). The accompanying
 * runtime parser (`src/ready/timeout.ts#parseDuration`) accepts exactly
 * this surface; the schema is the user-facing front line so a config typo
 * like `timeout: "forever"` fails at `lich validate` rather than at
 * service-start time.
 *
 * Tests mirror the structure of `schema-fail-when.test.ts` (same ajv
 * config, same error-introspection pattern) so the test suite stays
 * readable across the Plan 4 schema-tightening tasks.
 */

import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

/** Build a fresh ajv with the same settings as the production validator. */
function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

/** Compile the root schema once per test for hermetic state. */
function compile() {
  return makeAjv().compile(schema);
}

describe("config/schema — ready_when.timeout", () => {
  it("accepts ready_when.timeout: '30s' (seconds suffix)", () => {
    // The canonical happy path — the most common form users will write.
    // Surface validator errors on failure so a regression is diagnosable.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "30s" },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '2m' (minutes suffix)", () => {
    // Minute-scale timeouts are how the dogfood stack waits for supabase.
    // Keeping a dedicated case per suffix means a regex regression that
    // accepts seconds but not minutes is instantly diagnosable.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "2m" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '1h' (hours suffix)", () => {
    // Hour scale exists primarily as a sanity check that the regex
    // alternation works end-to-end. Realistic configs won't hit this, but
    // a future addition that breaks the `h` branch should fail here.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "1h" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '500ms' (millisecond suffix)", () => {
    // The `ms` suffix is the only TWO-CHARACTER suffix; verifying it
    // separately catches a regex that accidentally treats the `m` and `s`
    // as alternates rather than requiring exact `ms`.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "500ms" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: 500 (raw integer ms)", () => {
    // The integer branch is the union's second arm. Accepting it lets
    // users who think in numbers (`60000`) skip the suffix dance.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 500 },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: 60000 (larger raw integer)", () => {
    // The dogfood stack's previous `90s` timeout is `90_000` as an
    // integer. Verify the integer branch isn't artificially capped low.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 60_000 },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '60000' (bare digits as string)", () => {
    // The pattern `^[0-9]+(ms|s|m|h)?$` makes the suffix optional, so
    // `"60000"` is a valid string form (the runtime parser treats it as
    // milliseconds, same as `"60000ms"`). Tested separately because a
    // future schema tightening might inadvertently require the suffix.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "60000" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects ready_when.timeout: 'forever' with a useful error", () => {
    // The canonical user typo. The schema must reject this so the user
    // sees a validate-time error rather than discovering at runtime that
    // their service somehow has no deadline. The error message should at
    // minimum reference the path so `lich validate`'s output is useful.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "forever" },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    // At least one error must reference the timeout path. The ajv error
    // chain for a `oneOf` failure is verbose (pattern fail + type fail +
    // overall-oneOf-fail), so we just check the path appears somewhere.
    expect(
      errors.some((e) => /timeout/.test(e.instancePath)),
    ).toBe(true);
  });

  it("rejects ready_when.timeout: '5 minutes' (whitespace + word suffix)", () => {
    // Common alternative typo. The grammar is intentionally narrow — no
    // English suffixes, no whitespace inside the value. Surfacing this at
    // validate time keeps the runtime parser's grammar matching the schema.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "5 minutes" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: '-1s' (negative)", () => {
    // The pattern bans leading signs, so `-1s` fails the regex outright.
    // Tested explicitly because "negative timeout" is a logical category
    // a future schema author might forget to defend against.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "-1s" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: -1 (negative raw integer)", () => {
    // The integer branch uses `minimum: 1`, which rejects both `-1` and
    // `0`. This is the integer-form companion to the negative-string test.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: -1 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: 0 (zero raw integer)", () => {
    // Zero is rejected by `minimum: 1`. A `timeout: 0` would mean "fail
    // instantly" which is never useful and almost certainly a config bug
    // (e.g. an env-substituted value that resolved to empty).
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 0 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: 1.5 (fractional raw number)", () => {
    // `type: integer` rejects non-integer numbers. Decimals don't make
    // sense for "milliseconds" and would push the user toward suffix form
    // (`"1500ms"`) which expresses the same idea cleanly.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 1.5 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: '30sec' (unknown suffix)", () => {
    // `sec` isn't a supported suffix even though it's a natural English
    // abbreviation. Keeping the suffix set to exactly the four documented
    // values means users learn the syntax once and can rely on it.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "30sec" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: true (wrong type)", () => {
    // The `oneOf` accepts string OR integer — booleans match neither.
    // Defensive against a future ajv coerce-friendly settings change.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: true },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: { value: 30 } (object form)", () => {
    // A user reaching for the `port: { env, host_port }` pattern might
    // try `timeout: { value: 30 }` by analogy. The schema rejects this
    // so they see a clear "wrong shape" error rather than a silent
    // ignore.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: { value: 30 } },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts ready_when without a timeout (optional)", () => {
    // `timeout` is optional — when unset, `up.ts` will apply the spec
    // default (60s). This test guards against accidentally making the
    // field required during the schema tightening.
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health" },
        },
      },
    });
    expect(ok).toBe(true);
  });
});
